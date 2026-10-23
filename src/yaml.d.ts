// YAML imports: Vite (and Vitest) turn them into plain data at build time.
declare module "*.yaml" {
  const value: unknown;
  export default value;
}
