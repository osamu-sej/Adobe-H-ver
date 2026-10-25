// tesseract.js のブラウザ向けESMビルド（default に本体と同じものが入っている）
declare module "tesseract.js/dist/tesseract.esm.min.js" {
  import Tesseract from "tesseract.js";
  export default Tesseract;
}
