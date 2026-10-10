const projectRoot = new URL("../", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const projectPath = specifier.slice(2) + ".ts";
    return nextResolve(new URL(projectPath, projectRoot).href, context);
  }

  return nextResolve(specifier, context);
}
