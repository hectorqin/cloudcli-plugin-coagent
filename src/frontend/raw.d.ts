/** `import text from './file.css?raw'`: the file's contents as a string (esbuild plugin in build.mjs; native in vitest). */
declare module '*?raw' {
  const text: string;
  export default text;
}
