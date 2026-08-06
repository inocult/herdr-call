declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }
  interface QrcodeTerminal {
    generate(text: string, options: GenerateOptions, callback: (qr: string) => void): void;
    generate(text: string, callback: (qr: string) => void): void;
    setErrorLevel(level: "L" | "M" | "Q" | "H"): void;
  }
  const qrcode: QrcodeTerminal;
  export default qrcode;
}
