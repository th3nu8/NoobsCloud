// Edit this list to match the games actually installed on your Android
// template VM. Find each package + launch activity with:
//   adb shell cmd package resolve-activity --brief <package.name>
// (run against your template while it's on, before cloning)
module.exports = [
  {
    id: 'game1',
    name: 'Example Game One',
    package: 'com.example.gameone',
    activity: 'com.example.gameone.MainActivity',
  },
  {
    id: 'game2',
    name: 'Example Game Two',
    package: 'com.example.gametwo',
    activity: 'com.example.gametwo.MainActivity',
  },
];
