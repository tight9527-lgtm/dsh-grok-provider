let sharpModule

/**
 * Convert a WebP request projection to a format accepted by xAI Responses.
 * Transparent images stay lossless as PNG; opaque images use JPEG to keep the
 * request bounded without sending an unsupported WebP data URL upstream.
 */
export async function transcodeRequestImage(
  { data, hasAlpha },
  { maxBytes, maxPixels, maxDimension },
) {
  const mediaType = hasAlpha ? "image/png" : "image/jpeg"
  const sharp = await loadSharp()
  const image = sharp(data, {
    failOn: "error",
    limitInputPixels: maxPixels,
  }).toColourspace("srgb")
  const metadata = await image.metadata()
  if (
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width <= 0 ||
    metadata.height <= 0 ||
    metadata.width > maxDimension ||
    metadata.height > maxDimension ||
    metadata.width * metadata.height > maxPixels
  ) {
    throw new Error("The source image exceeds the route policy")
  }
  const encoded = hasAlpha
    ? image.png({ compressionLevel: 9 })
    : image.jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
  const result = await encoded.toBuffer({ resolveWithObject: true })
  if (
    !(result.data instanceof Uint8Array) ||
    result.data.byteLength === 0 ||
    result.data.byteLength > maxBytes ||
    !Number.isSafeInteger(result.info.width) ||
    !Number.isSafeInteger(result.info.height) ||
    result.info.width <= 0 ||
    result.info.height <= 0 ||
    result.info.width * result.info.height > maxPixels
  ) {
    throw new Error("The transcoded request image exceeds the route policy")
  }
  return {
    data: new Uint8Array(result.data),
    mediaType,
    bytes: result.data.byteLength,
    width: result.info.width,
    height: result.info.height,
    hasAlpha,
  }
}

async function loadSharp() {
  sharpModule ??= import("sharp").then((module) => module.default ?? module)
  return sharpModule
}
