// @ts-check
import path from "path";
import objectHash from "object-hash";
import { getCachedBuffer } from "../utils/cache.js";
import { getAssetPath, getConfigOptions } from "../utils/shared.js";
import { sharp, supportedImageTypes } from "../../runtimeChecks.js";

const { getLoadedImage, getTransformedImage } = await (sharp
  ? import("../utils/imagetools.js")
  : import("../utils/codecs.js"));

export default async function load(
  id,
  { pwd, store, environment, projectBase, assetFileNames }
) {
  try {
    var fileURL = new URL(`file://${id}`);
  } catch (error) {
    return null;
  }

  const { search, searchParams } = fileURL;

  id = id.replace(search, "");

  const ext = path.extname(id).slice(1);

  if (supportedImageTypes.includes(ext)) {
    const src = id.startsWith(pwd) ? id : pwd + id;

    const base = path.basename(src, path.extname(src));

    const config = Object.fromEntries(searchParams);

    const { image: loadedImage, width: imageWidth } =
      store.get(src) || store.set(src, await getLoadedImage(src, ext)).get(src);

    const { type, widths, options, extension, inline } = getConfigOptions(
      config,
      ext,
      imageWidth
    );

    if (inline) {
      if (widths.length > 1) {
        throw new Error(
          `Cannot use base64 or raw or inline with multiple widths`
        );
      }

      const [width] = widths;

      const hash = objectHash([src, width, options]);

      if (store.has(hash)) {
        return `export default "${store.get(hash)}"`;
      } else {
        const config = { width, ...options };

        const params = [src, loadedImage, config, type];

        const { image, buffer } = await getTransformedImage(...params);

        const dataUri = `data:${type};base64,${(
          buffer || (await getCachedBuffer(hash, image))
        ).toString("base64")}`;

        store.set(hash, dataUri);

        return `export default "${dataUri}"`;
      }
    } else {
      const sources = await Promise.all(
        widths.map(async (width) => {
          const hash = objectHash([src, width, options]);

          const assetPath = getAssetPath(
            base,
            assetFileNames,
            extension,
            width,
            hash
          );

          if (!store.has(assetPath)) {
            const config = { width, ...options };

            const params = [src, loadedImage, config, type];

            const { image, buffer } = await getTransformedImage(...params);

            const imageObject = { hash, type, image, buffer };

            store.set(assetPath, imageObject);
          }

          const modulePath =
            environment === "dev" ? assetPath : projectBase + assetPath;

          return { width, modulePath };
        })
      );

      const srcset =
        sources.length > 1
          ? sources
              .map(({ width, modulePath }) => `${modulePath} ${width}w`)
              .join(", ")
          : sources[0].modulePath;

      return `export default "${srcset}"`;
    }
  }
}