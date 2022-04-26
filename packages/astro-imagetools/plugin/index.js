// @ts-check
import path from "path";
import crypto from "crypto";
import stream from "stream";
import objectHash from "object-hash";
import MagicString from "magic-string";
import { sharp, supportedImageTypes } from "../runtimeChecks.js";
import { getConfigOptions, getAssetPath } from "./utils/shared.js";
import { saveAndCopyAsset, getCachedBuffer } from "./utils/cache.js";

const { getLoadedImage, getTransformedImage } = await (sharp
  ? import("./utils/imagetools.js")
  : import("./utils/codecs.js"));

const cwd = process.cwd().split(path.sep).join(path.posix.sep);

let viteConfig;
const store = new Map();

let environment, projectBase, outDir, assetsDir, assetFileNames, sourcemap;

const regexTestPattern =
  /<img\s+src\s*=(?:"|')([^("|')]*)(?:"|')\s*alt\s*=\s*(?:"|')([^("|')]*)(?:"|')[^>]*>/;

const regexExecPattern =
  /(?<=(?:\$\$render`.*))<img\s+src\s*=(?:"|')([^("|')]*)(?:"|')\s*alt\s*=\s*(?:"|')([^("|')]*)(?:"|')[^>]*>(?=.*`)/gs;

export default function vitePlugin({ config, command }) {
  projectBase = path.normalize(config.base);

  environment = command;

  if (!projectBase.startsWith("/")) projectBase = "/" + projectBase;

  if (projectBase.endsWith("/")) projectBase = projectBase.slice(0, -1);

  return plugin;
}

const plugin = {
  name: "vite-plugin-astro-imagetools",
  enforce: "pre",

  config: () => ({
    optimizeDeps: {
      exclude: ["@astropub/codecs", "imagetools-core", "sharp"],
    },
    ssr: {
      external: [
        "sharp",
        "potrace",
        "file-type",
        "object-hash",
        "find-cache-dir",
        "@astropub/codecs",
      ],
    },
  }),

  configResolved(config) {
    viteConfig = config;

    ({ outDir, assetsDir, sourcemap } = viteConfig.build);

    assetFileNames = path.normalize(
      viteConfig.build.rollupOptions.output?.assetFileNames ||
        `/${assetsDir}/[name].[hash][extname]`
    );

    if (!assetFileNames.startsWith("/")) assetFileNames = "/" + assetFileNames;
  },

  async load(id) {
    if (this.load) {
      // @ts-ignore
      global.vitePluginContext = {
        load: this.load,
      };
    }

    try {
      var fileURL = new URL(`file://${id}`);
    } catch (error) {
      return null;
    }

    const { search, searchParams } = fileURL;

    id = id.replace(search, "");

    const ext = path.extname(id).slice(1);

    if (supportedImageTypes.includes(ext)) {
      const src = id.startsWith(cwd) ? id : cwd + id;

      const base = path.basename(src, path.extname(src));

      const config = Object.fromEntries(searchParams);

      const { image: loadedImage, width: imageWidth } =
        store.get(src) ||
        store.set(src, await getLoadedImage(src, ext)).get(src);

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
  },

  async transform(code, id) {
    if (id.endsWith(".md") && regexTestPattern.test(code)) {
      let matches;

      if ((matches = code.matchAll(regexExecPattern)) !== null) {
        const s = new MagicString(code);

        const uuid = crypto.randomBytes(4).toString("hex");

        const Picture = "Picture" + uuid;

        const renderComponent = "renderComponent" + uuid;

        s.prepend(
          `import { Picture as ${Picture} } from "astro-imagetools/components";\nimport { renderComponent as ${renderComponent} } from "${
            cwd + "/node_modules/astro/dist/runtime/server/index.js"
          }"\n;`
        );

        for (const match of matches) {
          const [matchedText, rawSrc, alt] = match;

          const src = rawSrc.match("(http://|https://|data:image/).*")
            ? rawSrc
            : path.resolve(path.dirname(id), rawSrc).replace(cwd, "");

          s.overwrite(
            match.index,
            match.index + matchedText.length,
            `\${${renderComponent}($$result, "${Picture}", ${Picture}, { "src": "${src}", "alt": "${alt}" })}`
          );
        }

        return {
          code: s.toString(),
          map: sourcemap ? s.generateMap({ hires: true }) : null,
        };
      }
    }
  },

  async configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const imageObject = store.get(request.url);

      if (imageObject) {
        const { hash, type, image, buffer } = imageObject;

        response.setHeader("Content-Type", type);
        response.setHeader("Cache-Control", "no-cache");

        return stream.Readable.from(
          buffer || (await getCachedBuffer(hash, image))
        ).pipe(response);
      }

      next();
    });
  },

  async closeBundle() {
    if (viteConfig.mode === "production") {
      const allEntries = [...store.entries()];

      const assetPaths = allEntries.filter(([, { hash = null } = {}]) => hash);

      await Promise.all(
        assetPaths.map(
          async ([assetPath, { hash, image, buffer }]) =>
            await saveAndCopyAsset(
              hash,
              image,
              buffer,
              outDir,
              assetsDir,
              assetPath
            )
        )
      );
    }
  },
};
