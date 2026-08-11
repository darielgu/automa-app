import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, app } from "electron";
import { GUEST_RESUME_FILE_NAME, guestResumeHtml } from "./guest-persona.js";

/**
 * Renders the demo résumé to a real PDF using Electron's own printToPDF.
 *
 * Deliberately not a PDF library: Electron already embeds Chromium, so this
 * adds zero bytes to the dependency tree and produces a file that real ATS
 * upload fields accept and real parsers can read.
 */
export async function generateGuestResume(): Promise<{
  filePath: string;
  fileName: string;
  sizeBytes: number;
}> {
  const dir = path.join(app.getPath("userData"), "resumes");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, GUEST_RESUME_FILE_NAME);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      // The résumé is static markup we generate. No scripts, no network, no
      // preload: nothing to execute means nothing to exploit.
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(guestResumeHtml())}`);
    const pdf = await win.webContents.printToPDF({
      pageSize: "Letter",
      printBackground: true,
      margins: { marginType: "none" }
    });
    await fs.writeFile(filePath, pdf);
    return { filePath, fileName: GUEST_RESUME_FILE_NAME, sizeBytes: pdf.byteLength };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
