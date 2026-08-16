# 音乐文件夹

把音乐文件（.mp3 / .wav / .ogg）放到这个文件夹里。

然后在 `js/game.js` 顶部的 `musicList` 数组中添加文件名，例如：

```js
const musicList = [
    'assets/music/song1.mp3',
    'assets/music/song2.mp3',
];
```

歌名会自动从文件名中提取（去掉扩展名和路径）。
