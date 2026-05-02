// Stub for `canvas` — prismarine-viewer only uses createCanvas for player
// nametags. We have one bot, no nametags to render, so a 1x1 blank canvas
// is fine. Avoids canvas's native compile step that hangs inside BrowserPod.
module.exports = {
  createCanvas: () => ({
    width: 1,
    height: 1,
    getContext: () => ({
      fillStyle: "",
      font: "",
      textAlign: "",
      textBaseline: "",
      fillText: () => {},
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      measureText: () => ({ width: 0 }),
    }),
    toBuffer: () => Buffer.alloc(0),
  }),
  loadImage: async () => ({ width: 1, height: 1 }),
  Image: function Image() {},
};
