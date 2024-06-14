// core.js (Mock for @actions/core)
const inputs = {
    'unity-version': '2022.3.21f1',
    'unity-version-changeset': '50fe8a171dd9',
    'unity-modules': 'webgl',
    'unity-modules-child': 'true',
    'install-path': '/home/codespace/unity-install',
    'project-path': '/workspaces/curly-waffle',
    'self-hosted': 'false'
};

module.exports = {
    getInput: (name) => inputs[name] || '',
    setOutput: (name, value) => console.log(`Output - ${name}: ${value}`),
    exportVariable: (name, value) => console.log(`Export - ${name}: ${value}`),
    setFailed: (message) => console.error(`Failed: ${message}`)
};
