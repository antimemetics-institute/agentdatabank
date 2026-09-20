declare module "virtual:experiment-pages" {
  import type { ComponentType } from "react";
  const pages: Record<string, () => Promise<{ default: ComponentType<{ components: Record<string, unknown> }> }>>;
  export default pages;
}
