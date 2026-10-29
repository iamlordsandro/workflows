const { readFileSync } = require('node:fs');
const path = require('node:path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runWorkflow(filename, { github, context, env = {}, core = {} }) {
  const source = readFileSync(path.resolve(__dirname, '..', filename), 'utf8');
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*script:\s*\|\s*$/.test(line));
  if (start === -1) throw new Error(`No inline script found in ${filename}.`);

  const fieldIndent = lines[start].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= fieldIndent) break;
    body.push(line);
  }
  const indents = body.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length);
  if (!indents.length) throw new Error(`Empty inline script in ${filename}.`);
  const scriptIndent = Math.min(...indents);
  const script = body.map((line) => line.slice(scriptIndent)).join('\n');
  const noop = () => {};
  const toolkit = {
    info: noop,
    warning: noop,
    error: noop,
    debug: noop,
    notice: noop,
    setOutput: noop,
    setFailed(message) { throw new Error(message); },
    ...core,
  };
  return new AsyncFunction('github', 'context', 'core', 'process', script)(
    github, context, toolkit, { env },
  );
}

module.exports = { runWorkflow };
