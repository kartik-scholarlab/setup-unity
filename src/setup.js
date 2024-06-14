const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const path = require('path');
const fs = require('fs');

async function run() {
    try {
        let unityVersion = core.getInput('unity-version');
        let unityVersionChangeset = core.getInput('unity-version-changeset');
        const unityModules = getInputAsArray('unity-modules');
        const unityModulesChild = getInputAsBool('unity-modules-child');
        const installPath = core.getInput('install-path');
        const projectPath = core.getInput('project-path');
        const selfHosted = getInputAsBool('self-hosted');

        if (!unityVersion) {
            console.log('project path :'+ projectPath);
            [unityVersion, unityVersionChangeset] = await findProjectVersion(projectPath);
        } else if (!unityVersionChangeset) {
            unityVersionChangeset = await findVersionChangeset(unityVersion);
        }
        const unityHubPath = await installUnityHub(selfHosted);
        const unityPath = await installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset, selfHosted);
        if (unityModules.length > 0) {
            await installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild);
        }
        await postInstall(selfHosted);

        core.setOutput('unity-version', unityVersion);
        core.setOutput('unity-path', unityPath);
        core.exportVariable('UNITY_PATH', unityPath);
    } catch (error) {
        core.setFailed(error.message);
    }
}

async function installUnityHub(selfHosted) {
    let unityHubPath = '';
    if (process.platform === 'linux') {
        unityHubPath = `${process.env.HOME}/UnityHub/UnityHub.AppImage`;

        // Ensure the Unity Hub directory exists
        await execute(`mkdir -p "${process.env.HOME}/UnityHub" "${process.env.HOME}/.config/Unity Hub"`);

        // Download the AppImage
        const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHub.AppImage');

        // Move the AppImage to the Unity Hub directory
        await execute(`mv "${installerPath}" "${unityHubPath}"`);

        // Install FUSE
        await execute('sudo apt-get update');
        await execute('sudo apt-get install -y fuse');

        // Make the AppImage executable
        await execute(`chmod +x "${unityHubPath}"`);

        try
        {
            // Run the AppImage to extract its contents
            await execute(`${unityHubPath} --appimage-extract`);
        }
        catch (error) {
            console.error('Error during AppImage extraction:', error);
            throw new Error('Failed to extract Unity Hub AppImage');
        }

        // Make sure the extracted binary is executable
        await execute(`chmod +x "${unityHubPath}"`);

        // Use the extracted binary instead of the AppImage
        //unityHubPath = extractedHubPath;

        try {
            await execute('apt-get update', { sudo: !selfHosted });
            await execute('apt-get install -y libgconf-2-4 libglu1 libasound2 libgtk2.0-0 libgtk-3-0 libnss3 zenity xvfb', { sudo: !selfHosted });
        } catch (error) {
            // Log the error but continue
            core.error(error);
        }

    } else if (process.platform === 'darwin') {
        unityHubPath = '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub';
        if (!fs.existsSync(unityHubPath)) {
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.dmg');
            await execute(`hdiutil mount "${installerPath}"`, { sudo: !selfHosted });
            const hubVolume = (await execute('ls /Volumes')).match(/Unity Hub.*/)[0];
            await execute(`ditto "/Volumes/${hubVolume}/Unity Hub.app" "/Applications/Unity Hub.app"`);
            await execute(`hdiutil detach "/Volumes/${hubVolume}"`, { sudo: !selfHosted });
            await execute(`rm "${installerPath}"`);
        }

    } else if (process.platform === 'win32') {
        unityHubPath = 'C:/Program Files/Unity Hub/Unity Hub.exe';
        if (!fs.existsSync(unityHubPath)) {
            const installerPath = await tc.downloadTool('https://public-cdn.cloud.unity3d.com/hub/prod/UnityHubSetup.exe');
            await execute(`"${installerPath}" /s`);
            await execute(`del "${installerPath}"`);
        }

    } else {
        throw new Error('Unknown platform');
    }

    return unityHubPath;
}

async function installUnityEditor(unityHubPath, installPath, unityVersion, unityVersionChangeset, selfHosted) {
    let unityPath = await findUnity(unityHubPath, unityVersion);
    if (!unityPath) {
        if (installPath) {
            if (process.platform === 'linux' || process.platform === 'darwin') {
                await execute(`mkdir -p "${installPath}"`, { sudo: !selfHosted });
                await execute(`chmod -R o+rwx "${installPath}"`, { sudo: !selfHosted });
            }
            await executeHub(unityHubPath, `install-path --set "${installPath}"`);
        }
        await executeHub(unityHubPath, `install --version ${unityVersion} --changeset ${unityVersionChangeset}`);
        unityPath = await findUnity(unityHubPath, unityVersion);
        if (!unityPath) {
            throw new Error('unity editor installation failed');
        }
    }
    return unityPath;
}

async function installUnityModules(unityHubPath, unityVersion, unityModules, unityModulesChild) {
    const modulesArgs = unityModules.map(s => `--module ${s.toLowerCase()}`).join(' ');
    const childModulesArg = unityModulesChild ? '--childModules' : '';
    const stdout = await executeHub(unityHubPath, `install-modules --version ${unityVersion} ${modulesArgs} ${childModulesArg}`);
    if (!stdout.includes('successfully') && !stdout.includes("it's already installed")) {
        throw new Error('unity modules installation failed');
    }
}

async function postInstall(selfHosted) {
    if (process.platform === 'darwin') {
        await execute('mkdir -p "/Library/Application Support/Unity"', { sudo: !selfHosted });
        await execute(`chown -R ${process.env.USER} "/Library/Application Support/Unity"`, { sudo: !selfHosted });
    }
}

async function findUnity(unityHubPath, unityVersion) {
    let unityPath = '';
    const output = await executeHub(unityHubPath, `editors --installed`);
    const match = output.match(new RegExp(`${unityVersion}.+, installed at (.+)`));
    if (match) {
        unityPath = match[1];
        if (unityPath && process.platform === 'darwin') {
            unityPath += '/Contents/MacOS/Unity';
        }
    }
    return unityPath;
}

async function findProjectVersion(projectPath) {
    const filePath = path.join(projectPath, 'ProjectSettings/ProjectVersion.txt');
    if (fs.existsSync(filePath)) {
        const fileText = fs.readFileSync(filePath, 'utf8');
        const match1 = fileText.match(/m_EditorVersionWithRevision: (.+) \((.+)\)/);
        if (match1) {
            const version = match1[1];
            const changeset = match1[2];
            return [version, changeset];
        }
        const match2 = fileText.match(/m_EditorVersion: (.+)/);
        if (match2) {
            const version = match2[1];
            const changeset = await findVersionChangeset(version);
            return [version, changeset];
        }
    }
    throw new Error(`Project not found at path: ${projectPath}`);
}

async function findVersionChangeset(unityVersion) {
    let changeset = '';
    try {
        let versionPageUrl;
        if (unityVersion.includes('a')) {
            versionPageUrl = 'https://unity3d.com/unity/alpha/' + unityVersion;
        } else if (unityVersion.includes('b')) {
            versionPageUrl = 'https://unity3d.com/unity/beta/' + unityVersion;
        } else if (unityVersion.includes('f')) {
            versionPageUrl = 'https://unity3d.com/unity/whats-new/' + unityVersion.match(/[.0-9]+/)[0];
        }
        const pagePath = await tc.downloadTool(versionPageUrl); // support retry
        const pageText = fs.readFileSync(pagePath, 'utf8');
        const match = pageText.match(new RegExp(`unityhub://${unityVersion}/([a-z0-9]+)`)) || pageText.match(/Changeset:<\/span>[ \n]*([a-z0-9]{12})/);
        changeset = match[1];
    } catch (error) {
        core.error(error);
    }
    if (!changeset) {
        throw new Error("Can't find Unity version changeset automatically");
    }
    return changeset;
}

async function executeHub(unityHubPath, args) {
    if (process.platform === 'linux') {
        return await execute(`xvfb-run --auto-servernum "${unityHubPath}" --headless ${args}`, { ignoreReturnCode: true });
    } else if (process.platform === 'darwin') {
        return await execute(`"${unityHubPath}" -- --headless ${args}`, { ignoreReturnCode: true });
    } else if (process.platform === 'win32') {
        // unityhub always return exit code 1
        return await execute(`"${unityHubPath}" -- --headless ${args}`, { ignoreReturnCode: true });
    }
}

async function execute(command, options) {
    let stdout = '';
    const prefix = options?.sudo == true ? 'sudo ' : '';
    await exec.exec(prefix + command, [], {
        ignoreReturnCode: options?.ignoreReturnCode,
        listeners: {
            stdout: buffer => stdout += buffer.toString()
        }
    });
    console.log(); // new line
    return stdout;
}

function getInputAsArray(name, options) {
    return core
        .getInput(name, options)
        .split("\n")
        .map(s => s.trim())
        .filter(x => x !== "");
}

function getInputAsBool(name, options) {
    return core.getInput(name, options).toLowerCase() === 'true';
}

run();

