/* Dev-only gallery (#/dev/diagrams, registered only under import.meta.env.DEV):
   every fixture rendered through the exact component the builder will one day
   use, against the live theme. The iteration loop for the diagram prototype —
   poor-man's storybook, zero dependencies. Headless twin: render.test.ts writes
   the same fixtures to web/test/diagram-renders/. */

import { ExperimentDiagram } from "@/components/diagram";
import { fixtures } from "@/lib/diagram/fixtures.ts";

export function DevDiagramsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">diagram fixtures</h1>
        <p className="text-sm text-muted-foreground">
          The experiment-diagram prototype (src/lib/diagram) rendered over its draft manifest
          specs. Not linked from the sidebar; dev builds only.
        </p>
      </div>
      {fixtures.map((f) => (
        <section key={f.name} className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 font-mono text-sm text-muted-foreground">{f.title}</h2>
          <ExperimentDiagram spec={f.spec} params={f.params} />
        </section>
      ))}
    </div>
  );
}
