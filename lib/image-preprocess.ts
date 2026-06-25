import sharp from "sharp";

const IMAGE_EXT = /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif)$/i;

/** Whether a file name looks like a raster photo/scan (not a PDF or MusicXML). */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.test(name);
}

/**
 * Clean up a photographed/scanned page before OMR. Phone photos especially
 * are low-contrast, off-angle-lit, and sometimes small or EXIF-rotated, which
 * trips up Audiveris. We auto-orient, go grayscale, stretch contrast, upscale
 * small images so staff lines are thick enough, and lightly sharpen. Audiveris
 * does its own adaptive binarization, so we deliberately stop short of
 * thresholding (a hard threshold wrecks photos with uneven lighting).
 *
 * Returns a PNG buffer, or null if preprocessing fails (caller keeps original).
 */
export async function preprocessImage(
  input: Uint8Array
): Promise<Buffer | null> {
  try {
    const base = sharp(input, { failOn: "none" }).rotate(); // EXIF auto-orient
    const meta = await base.metadata();

    const targetWidth = 2200;
    const pipeline =
      meta.width && meta.width < targetWidth
        ? base.resize({ width: targetWidth, withoutEnlargement: false })
        : base;

    return await pipeline
      .grayscale()
      .normalize() // stretch the histogram to full black↔white range
      .sharpen()
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}
