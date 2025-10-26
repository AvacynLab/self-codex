import Module from "node:module";

const resolver = Module.createRequire(import.meta.url);

try {
  resolver("tinyld");
} catch {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === "tinyld") {
      return { detect: () => "en" };
    }
    return originalLoad(request, parent, isMain);
  } as typeof Module._load;
}
