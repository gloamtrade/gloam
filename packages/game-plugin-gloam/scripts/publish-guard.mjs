// npm ignores publishConfig's main, types and exports, so a package published with npm points at
// src/*.ts and plain Node can't import it. pnpm applies them (dist/), so only pnpm may publish.
const agent = process.env.npm_config_user_agent ?? "";
if (!agent.startsWith("pnpm/")) {
  console.error("Publish @gloamtrade/game-plugin-gloam with pnpm: `pnpm publish --access public`.");
  console.error("npm ignores publishConfig, so the published main and exports would point at src/*.ts.");
  process.exit(1);
}
