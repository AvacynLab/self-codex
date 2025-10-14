declare module "yaml" {
  export function parse<T = unknown>(content: string): T;
}
