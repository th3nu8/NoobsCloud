"""
NoobsCloud accounts + credits service.

Runs as its OWN service, separate from any Redroid/Docker-host machine.
Owns: user accounts, password hashes, credit balances, session billing.

Responsibilities:
  - Signup / login (returns a JWT)
  - GET  /me                      -> current balance
  - POST /credits/add              -> top up a balance (stub — wire to real
                                       payment processing yourself; this repo
                                       doesn't include a payment integration)
  - POST /billing/session/start    -> called by the broker before spinning up
                                       a Redroid session; rejects if balance <= 0
  - POST /billing/session/tick     -> called periodically (e.g. every 60s) by
                                       the broker while a session is active;
                                       deducts 1 credit, returns whether to
                                       keep the session alive
  - POST /billing/session/stop     -> called by the broker when a session ends
                                       for any reason; closes out billing

SQLite here for simplicity — swap for Postgres by changing DATABASE_URL if
you want this to run under real concurrent load.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel

DB_PATH = os.environ.get("ACCOUNTS_DB_PATH", "accounts.db")
JWT_SECRET = os.environ["JWT_SECRET"]  # required — set this, never hardcode/commit it
JWT_ALGO = "HS256"
JWT_EXPIRY_HOURS = 24

app = FastAPI(title="NoobsCloud Accounts")


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                credits REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS billing_sessions (
                session_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                started_at TEXT NOT NULL,
                last_tick_at TEXT NOT NULL,
                ended_at TEXT,
                credits_spent REAL NOT NULL DEFAULT 0
            )
        """)


init_db()


# --- auth helpers -------------------------------------------------------

class SignupRequest(BaseModel):
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


def make_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def current_user_id(authorization: str = Header(...)) -> int:
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        return int(payload["sub"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token")


# --- signup / login -------------------------------------------------------

@app.post("/signup")
def signup(req: SignupRequest):
    pw_hash = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
    with db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, credits, created_at) VALUES (?, ?, 0, ?)",
                (req.email, pw_hash, datetime.now(timezone.utc).isoformat()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Email already registered")
        user_id = cur.lastrowid
    return {"token": make_token(user_id)}


@app.post("/login")
def login(req: LoginRequest):
    with db() as conn:
        row = conn.execute("SELECT id, password_hash FROM users WHERE email = ?", (req.email,)).fetchone()
    if not row or not bcrypt.checkpw(req.password.encode(), row["password_hash"].encode()):
        raise HTTPException(401, "Invalid email or password")
    return {"token": make_token(row["id"])}


@app.get("/me")
def me(user_id: int = Depends(current_user_id)):
    with db() as conn:
        row = conn.execute("SELECT email, credits FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"email": row["email"], "credits": row["credits"]}


# --- credits (top-up stub) -------------------------------------------------

class AddCreditsRequest(BaseModel):
    amount: float


@app.post("/credits/add")
def add_credits(req: AddCreditsRequest, user_id: int = Depends(current_user_id)):
    # STUB: this just adds credits directly with no payment check. Before
    # going live, put a real payment processor (Stripe, etc.) in front of
    # this endpoint and only call it after a verified successful charge.
    if req.amount <= 0:
        raise HTTPException(400, "Amount must be positive")
    with db() as conn:
        conn.execute("UPDATE users SET credits = credits + ? WHERE id = ?", (req.amount, user_id))
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"credits": row["credits"]}


# --- session billing (called by the broker, not the frontend) -------------

class SessionStartRequest(BaseModel):
    session_id: str


@app.post("/billing/session/start")
def billing_session_start(req: SessionStartRequest, user_id: int = Depends(current_user_id)):
    with db() as conn:
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
        if row["credits"] < 1:
            raise HTTPException(402, "Insufficient credits — need at least 1 to start a session")
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO billing_sessions (session_id, user_id, started_at, last_tick_at, credits_spent) "
            "VALUES (?, ?, ?, ?, 0)",
            (req.session_id, user_id, now, now),
        )
    return {"status": "billing_started"}


@app.post("/billing/session/{session_id}/tick")
def billing_session_tick(session_id: str):
    """
    Called by the broker roughly once a minute while a session is active.
    Deducts 1 credit per full minute elapsed since the last tick. Returns
    should_continue=False once the user's balance can't cover another minute
    — the broker is responsible for actually stopping the Redroid session
    when it sees that.
    """
    with db() as conn:
        session = conn.execute(
            "SELECT user_id, last_tick_at FROM billing_sessions WHERE session_id = ? AND ended_at IS NULL",
            (session_id,),
        ).fetchone()
        if not session:
            raise HTTPException(404, "No active billing session with that id")

        last_tick = datetime.fromisoformat(session["last_tick_at"])
        elapsed_minutes = int((datetime.now(timezone.utc) - last_tick).total_seconds() // 60)
        if elapsed_minutes < 1:
            return {"should_continue": True, "credits_charged": 0}

        user = conn.execute("SELECT credits FROM users WHERE id = ?", (session["user_id"],)).fetchone()
        chargeable = min(elapsed_minutes, int(user["credits"]))

        conn.execute("UPDATE users SET credits = credits - ? WHERE id = ?", (chargeable, session["user_id"]))
        conn.execute(
            "UPDATE billing_sessions SET last_tick_at = ?, credits_spent = credits_spent + ? WHERE session_id = ?",
            (datetime.now(timezone.utc).isoformat(), chargeable, session_id),
        )
        remaining = user["credits"] - chargeable

    return {"should_continue": remaining >= 1, "credits_charged": chargeable, "credits_remaining": remaining}


@app.post("/billing/session/{session_id}/stop")
def billing_session_stop(session_id: str):
    with db() as conn:
        conn.execute(
            "UPDATE billing_sessions SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
            (datetime.now(timezone.utc).isoformat(), session_id),
        )
    return {"status": "billing_stopped"}
