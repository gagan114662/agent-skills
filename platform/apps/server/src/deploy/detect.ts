/**
 * Pure stack detection (#73). Infers how to build + where the output lands from a parsed
 * `package.json` plus the app-root file listing, with a **trusted-config override** always winning.
 *
 * Pure (no filesystem) so it is exhaustively unit-testable and deterministic — the thin filesystem
 * wrapper that reads the manifest lives in the manager. The deploy *command* itself is never derived
 * from the request: it comes from config (the #56/#27 trust boundary); detection only fills the
 * framework/build/output hints a provider needs when config leaves them unset.
 */

/** A detected (or declared) app stack the provider builds + deploys. */
export interface DeployStack {
  /** `next` | `vite` | `cra` | `astro` | `node` | `static`. */
  framework: string;
  /** The build command (absent for a static site that needs none). */
  buildCommand?: string;
  /** The directory the build emits (served by the provider). */
  outputDir?: string;
}

/** The trusted-config deploy hints (repo/managed scope); any field overrides inference. */
export interface DeployConfigOverride {
  framework?: string;
  buildCommand?: string;
  outputDir?: string;
}

/** The minimal parsed `package.json` shape detection reads. */
export interface ParsedManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DetectInput {
  /** Parsed `package.json`, or null when the app root has none. */
  packageJson?: ParsedManifest | null;
  /** File names present at the app root (e.g. `["package.json", "next.config.js"]`). */
  files: string[];
}

/** Per-framework defaults (the values inference fills when config doesn't override them). */
const FRAMEWORK_DEFAULTS: Record<string, { buildCommand?: string; outputDir: string }> = {
  next: { buildCommand: "next build", outputDir: ".next" },
  astro: { buildCommand: "astro build", outputDir: "dist" },
  vite: { buildCommand: "vite build", outputDir: "dist" },
  cra: { buildCommand: "react-scripts build", outputDir: "build" },
  node: { buildCommand: "npm run build", outputDir: "dist" },
  static: { buildCommand: undefined, outputDir: "." },
};

/** Infer just the framework name from deps + files; never throws. */
function inferFramework(input: DetectInput): string {
  const pkg = input.packageJson ?? null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) return "next";
  if (deps.astro) return "astro";
  if (deps["react-scripts"]) return "cra";
  if (deps.vite) return "vite";
  // A package with its own build script but no recognized framework: run that build generically.
  if (pkg?.scripts?.build) return "node";
  return "static";
}

/**
 * Resolve the stack to build + deploy. Config (`override`) wins field-by-field over inference; a
 * configured `framework` re-bases the defaults, and a configured `buildCommand`/`outputDir` overrides
 * whatever the (configured or inferred) framework would use.
 */
export function detectStack(override: DeployConfigOverride | undefined, input: DetectInput): DeployStack {
  const framework = override?.framework ?? inferFramework(input);
  const defaults = FRAMEWORK_DEFAULTS[framework] ?? { buildCommand: undefined, outputDir: "." };
  return {
    framework,
    buildCommand: override?.buildCommand ?? defaults.buildCommand,
    outputDir: override?.outputDir ?? defaults.outputDir,
  };
}
