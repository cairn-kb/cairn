// Native libraries imported `with { type: "file" }` resolve to a path: the file
// itself in a source checkout, its `/$bunfs/` copy in a compiled binary.
declare module "*.dylib" {
  const path: string
  export default path
}
declare module "*.so" {
  const path: string
  export default path
}
