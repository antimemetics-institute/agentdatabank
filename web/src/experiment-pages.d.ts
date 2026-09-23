declare module "virtual:experiment-pages" {
  import type { ComponentType } from "react";
  const pages: Record<string, () => Promise<{ default: ComponentType<{ components: Record<string, unknown> }> }>>;
  export default pages;
}

declare module "virtual:experiment-thumbnails" {
  const thumbnails: Record<string, string>;
  export default thumbnails;
}
