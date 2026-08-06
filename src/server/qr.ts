import qrcode from "qrcode-terminal";

/** Render a URL as a compact half-block QR grid for the call pane. */
export async function renderQr(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, resolve);
  });
}
