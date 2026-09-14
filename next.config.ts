import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  webpack(config, { webpack }) {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
    };
    config.resolve.alias = {
      ...config.resolve.alias,
      "kiwi-wasm.wasm": path.resolve(
        process.cwd(),
        "node_modules/kiwi-nlp/dist/kiwi-wasm.wasm",
      ),
    };
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^node:(module|fs|path|url)$/ }),
      new webpack.NormalModuleReplacementPlugin(
        /lib[\\/]worker-factory\.ts$/,
        path.resolve(process.cwd(), "lib/worker-factory.next.ts"),
      ),
    );
    return config;
  },
};

export default nextConfig;
