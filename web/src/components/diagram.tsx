/* The app-side face of the diagram prototype: bind + layout + render against
   the live theme palette (CSS variables, so dark mode flips for free). Params
   are whatever the caller holds — the builder's live form state or a run's
   realized params — which is the whole point: the picture tracks the form. */

import { useMemo } from "react";
import { bindScene } from "@/lib/diagram/bind.ts";
import { layoutScene } from "@/lib/diagram/layout.ts";
import { APP, renderSvg } from "@/lib/diagram/render.ts";
import type { DiagramSpec, Params } from "@/lib/diagram/spec.ts";

export function ExperimentDiagram({ spec, params }: { spec: DiagramSpec; params: Params }) {
  /* renderSvg escapes every param-derived string at the XML boundary
     (render.test.ts holds that line), so the markup is self-authored, not user HTML */
  const svg = useMemo(
    () => renderSvg(layoutScene(bindScene(spec, params)), APP),
    [spec, params],
  );
  return (
    <div
      className="w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full [&_svg]:h-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
