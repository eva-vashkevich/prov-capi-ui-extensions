//TODO nb sum aint right...changes made to accomodate erros with xmlbuilder2 and zod (new rancher/shell deps)
const fs = require('fs');
const path = require('path');
const config = require('@rancher/shell/vue.config'); // eslint-disable-line @typescript-eslint/no-var-requires

// When @rancher/shell is yarn-linked, webpack can't find the shell's own
// dependencies (they live in the dashboard's node_modules, not ours).
// Detect the symlink and add the dashboard's node_modules to resolve paths.
const shellPath = path.join(__dirname, 'node_modules', '@rancher', 'shell');
let linkedShellNodeModules;

if (fs.lstatSync(shellPath).isSymbolicLink()) {
  const realShellDir = fs.realpathSync(shellPath);

  linkedShellNodeModules = path.join(realShellDir, '..', 'node_modules');
}

const baseConfig = config(__dirname, {
  excludes: [],
});

if (linkedShellNodeModules) {
  const origChainWebpack = baseConfig.chainWebpack;

  baseConfig.chainWebpack = (chain) => {
    if (origChainWebpack) {
      origChainWebpack(chain);
    }

    chain.resolve.modules.add(linkedShellNodeModules);
  };
}

module.exports = baseConfig;
