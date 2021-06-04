/*
Copyright 2020-2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { promises as fsProm } from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';

import rimraf from 'rimraf';

import getSecret from './get_secret';
import GitRepo from './gitrepo';
import logger from './logger';

import Runner, { IRunner } from './runner';
import DockerRunner from './docker_runner';

import WindowsBuilder from './windows_builder';

// TODO: Expand this to a multi-level type with platform and arch.
const enum Type {
    Windows32 = 'win32',
    Windows64 = 'win64',
    macOS = 'mac',
    Linux = 'linux',
}

function isWindows(type: Type): boolean {
    switch (type) {
        case Type.Windows32:
        case Type.Windows64:
            return true;
        default:
            return false;
    }
}

// The set of types we build by default
const TYPES: Type[] = [
    Type.Windows64,
    Type.macOS,
    Type.Linux,
];

const DESKTOP_GIT_REPO = 'https://github.com/vector-im/element-desktop.git';
const ELECTRON_BUILDER_CFG_FILE = 'electron-builder.json';
const KEEP_BUILDS_NUM = 14; // we keep two week's worth of nightly builds

// take a date object and advance it to 9am the next morning
function getNextBuildTime(d: Date): Date {
    const next = new Date(d.getTime());
    next.setHours(8);
    next.setMinutes(0);
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (next.getTime() < d.getTime()) {
        next.setDate(next.getDate() + 1);
    }

    return next;
}

async function getLastBuildTime(type: Type): Promise<number> {
    try {
        return parseInt(await fsProm.readFile('desktop_develop_lastBuilt_' + type, 'utf8'));
    } catch (e) {
        logger.error(`Unable to read last build time for ${type}`, e);
        return 0;
    }
}

async function putLastBuildTime(type: Type, t: number): Promise<void> {
    try {
        await fsProm.writeFile('desktop_develop_lastBuilt_' + type, t.toString());
    } catch (e) {
        logger.error(`Unable to write last build time for ${type}`, e);
    }
}

function getBuildVersion(): string {
    // YYYYMMDDNN where NN is in case we need to do multiple versions in a day
    // NB. on windows, squirrel will try to parse the versiopn number parts,
    // including this string, into 32 bit integers, which is fine as long
    // as we only add two digits to the end...
    const now = new Date();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const date = now.getDate().toString().padStart(2, '0');
    const buildNum = '01';
    return now.getFullYear() + month + date + buildNum;
}

async function setDebVersion(ver: string, templateFile: string, outFile: string): Promise<void> {
    // Create a debian package control file with the version.
    // We use a custom control file so we need to do this ourselves
    let contents = await fsProm.readFile(templateFile, 'utf8');
    contents += 'Version: ' + ver + "\n";
    await fsProm.writeFile(outFile, contents);

    logger.info("Version set to " + ver);
}

async function getMatchingFilesInDir(dir: string, exp: RegExp): Promise<string[]> {
    const ret = [];
    for (const f of await fsProm.readdir(dir)) {
        if (exp.test(f)) {
            ret.push(f);
        }
    }
    if (ret.length === 0) throw new Error("No files found matching " + exp.toString() + "!");
    return ret;
}

async function getRepoTargets(repoDir: string): Promise<string[]> {
    const confDistributions = await fsProm.readFile(path.join(repoDir, 'conf', 'distributions'), 'utf8');
    const ret = [];
    for (const line of confDistributions.split('\n')) {
        if (line.startsWith('Codename')) {
            ret.push(line.split(': ')[1]);
        }
    }
    return ret;
}

function pullDebDatabase(debDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pulling debian database...", rsyncRoot + 'debian/', debDir);
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', rsyncRoot + 'debian/', debDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function pushDebDatabase(debDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pushing debian database...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', debDir + '/', rsyncRoot + 'debian',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

async function addDeb(debDir: string, deb: string): Promise<void> {
    const targets = await getRepoTargets(debDir);
    logger.info("Adding " + deb + " for " + targets.join(', ') + "...");
    for (const target of targets) {
        await new Promise<void>((resolve, reject) => {
            const proc = childProcess.spawn('reprepro', [
                'includedeb', target, deb,
            ], {
                stdio: 'inherit',
                cwd: debDir,
            });
            proc.on('exit', code => {
                code ? reject(code) : resolve();
            });
        });
    }
}

function pullArtifacts(pubDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Pulling artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', rsyncRoot + 'packages.riot.im/', pubDir,
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function pushArtifacts(pubDir: string, rsyncRoot: string): Promise<void> {
    logger.info("Uploading artifacts...");
    return new Promise((resolve, reject) => {
        const proc = childProcess.spawn('rsync', [
            '-av', '--delete', '--delay-updates', pubDir + '/', rsyncRoot + 'packages.riot.im',
        ], {
            stdio: 'inherit',
        });
        proc.on('exit', code => {
            code ? reject(code) : resolve();
        });
    });
}

function copyAndLog(src: string, dest: string): Promise<void> {
    logger.info('Copy ' + src + ' -> ' + dest);
    return fsProm.copyFile(src, dest);
}

async function pruneBuilds(dir: string, exp: RegExp): Promise<void> {
    const builds = await getMatchingFilesInDir(dir, exp);
    builds.sort();
    const toDelete = builds.slice(0, 0 - KEEP_BUILDS_NUM);
    if (toDelete.length) {
        logger.info("Pruning old builds: " + toDelete.join(', '));
    }
    for (const f of toDelete) {
        await fsProm.unlink(path.join(dir, f));
    }
}

function rm(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        rimraf(path, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

export default class DesktopDevelopBuilder {
    private pubDir = path.join(process.cwd(), 'packages.riot.im');
    // This should be a reprepro dir with a config redirecting
    // the output to pub/debian
    private debDir = path.join(process.cwd(), 'debian');
    private appPubDir = path.join(this.pubDir, 'nightly');
    private building = false;
    private riotSigningKeyContainer: string;
    private lastBuildTimes: Partial<Record<Type, number>> = {};
    private lastFailTimes: Partial<Record<Type, number>> = {};

    constructor(
        private winVmName: string,
        private winUsername: string,
        private winPassword: string,
        private rsyncRoot: string,
    ) { }

    public async start(): Promise<void> {
        logger.info("Starting Element Desktop nightly builder...");
        this.building = false;

        // get the token passphrase now so a) we fail early if it's not in the keychain
        // and b) we know the keychain is unlocked because someone's sitting at the
        // computer to start the builder.
        // NB. We supply the passphrase via a barely-documented feature of signtool
        // where it can parse it out of the name of the key container, so this
        // is actually the key container in the format [{{passphrase}}]=container
        this.riotSigningKeyContainer = await getSecret('riot_key_container');

        this.lastBuildTimes = {};
        this.lastFailTimes = {};
        for (const type of TYPES) {
            this.lastBuildTimes[type] = await getLastBuildTime(type);
            this.lastFailTimes[type] = 0;
        }

        setInterval(this.poll, 30 * 1000);
        this.poll();
    }

    private poll = async (): Promise<void> => {
        if (this.building) return;

        const toBuild: Type[] = [];
        for (const type of TYPES) {
            const nextBuildDue = getNextBuildTime(new Date(Math.max(
                this.lastBuildTimes[type], this.lastFailTimes[type],
            )));
            //logger.debug("Next build due at " + nextBuildDue);
            if (nextBuildDue.getTime() < Date.now()) {
                toBuild.push(type);
            }
        }

        if (toBuild.length === 0) return;

        try {
            this.building = true;

            // Sync all the artifacts from the server before we start
            await pullArtifacts(this.pubDir, this.rsyncRoot);

            for (const type of toBuild) {
                try {
                    logger.info("Starting build of " + type);
                    const thisBuildVersion = getBuildVersion();
                    await this.build(type, thisBuildVersion);
                    this.lastBuildTimes[type] = Date.now();
                    await putLastBuildTime(type, this.lastBuildTimes[type]);
                } catch (e) {
                    logger.error("Build failed!", e);
                    this.lastFailTimes[type] = Date.now();
                    // if one fails, bail out of the whole process: probably better
                    // to have all platforms not updating than just one
                    return;
                }
            }

            logger.info("Built packages for: " + toBuild.join(', ') + ": pushing packages...");
            await pushArtifacts(this.pubDir, this.rsyncRoot);
            logger.info("...push complete!");
        } catch (e) {
            logger.error("Artifact sync failed!", e);
            // Mark all types as failed if artifact sync fails
            for (const type of toBuild) {
                this.lastFailTimes[type] = Date.now();
            }
        } finally {
            this.building = false;
        }
    }

    private async writeElectronBuilderConfigFile(
        type: Type,
        repoDir: string,
        buildVersion: string,
    ): Promise<void> {
        // Electron builder doesn't overlay with the config in package.json,
        // so load it here
        const pkg = JSON.parse(await fsProm.readFile(path.join(repoDir, 'package.json'), 'utf8'));
        const cfg = pkg.build;

        // Electron crashes on debian if there's a space in the path.
        // https://github.com/vector-im/element-web/issues/13171
        const productName = type === Type.Linux ? 'Element-Nightly' : 'Element Nightly';

        // the windows packager relies on parsing this as semver, so we have
        // to make it look like one. This will give our update packages really
        // stupid names but we probably can't change that either because squirrel
        // windows parses them for the version too. We don't really care: nobody
        // sees them. We just give the installer a static name, so you'll just
        // see this in the 'about' dialog.
        // Turns out if you use 0.0.0 here it makes Squirrel windows crash, so we use 0.0.1.
        const version = isWindows(type) ? '0.0.1-nightly.' + buildVersion : buildVersion;

        Object.assign(cfg, {
            // We override a lot of the metadata for the nightly build
            extraMetadata: {
                name: "element-desktop-nightly",
                productName,
                version,
            },
            appId: "im.riot.nightly",
            deb: {
                fpm: [
                    "--deb-custom-control=debcontrol",
                ],
            },
        });
        await fsProm.writeFile(
            path.join(repoDir, ELECTRON_BUILDER_CFG_FILE),
            JSON.stringify(cfg, null, 4),
        );
    }

    private async build(type: Type, buildVersion: string): Promise<void> {
        if (isWindows(type)) {
            return this.buildWin(type, buildVersion);
        } else {
            return this.buildLocal(type, buildVersion);
        }
    }

    private async buildLocal(type: Type, buildVersion: string): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        const repoDir = path.join('builds', 'element-desktop-' + type + '-' + buildVersion);
        await rm(repoDir);
        logger.info("Cloning element-desktop into " + repoDir);
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        logger.info("...checked out 'develop' branch, starting build for " + type);

        await this.writeElectronBuilderConfigFile(type, repoDir, buildVersion);
        if (type === Type.Linux) {
            await setDebVersion(
                buildVersion,
                path.join(repoDir, 'element.io', 'nightly', 'control.template'),
                path.join(repoDir, 'debcontrol'),
            );
        }

        let runner: IRunner;
        switch (type) {
            case Type.macOS:
                runner = this.makeMacRunner(repoDir);
                break;
            case Type.Linux:
                runner = this.makeLinuxRunner(repoDir);
                break;
            default:
                throw new Error(`Unexpected local type ${type}`);
        }

        await this.buildWithRunner(runner, buildVersion, type);
        logger.info("Build completed!");

        if (type === Type.macOS) {
            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'macos'), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'macos'), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.dmg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', f),
                    // be consistent with windows and don't bother putting the version number
                    // in the installer
                    path.join(this.appPubDir, 'install', 'macos', 'Element Nightly.dmg'),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /-mac.zip$/)) {
                await copyAndLog(path.join(repoDir, 'dist', f), path.join(this.appPubDir, 'update', 'macos', f));
            }

            const latestPath = path.join(this.appPubDir, 'update', 'macos', 'latest');
            logger.info('Write ' + buildVersion + ' -> ' + latestPath);
            await fsProm.writeFile(latestPath, buildVersion);

            // prune update packages (the installer will just overwrite each time)
            await pruneBuilds(path.join(this.appPubDir, 'update', 'macos'), /-mac.zip$/);
        } else if (type === Type.Linux) {
            await pullDebDatabase(this.debDir, this.rsyncRoot);
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist'), /\.deb$/)) {
                await addDeb(this.debDir, path.resolve(repoDir, 'dist', f));
            }
            await pushDebDatabase(this.debDir, this.rsyncRoot);
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }

    private makeMacRunner(cwd: string): IRunner {
        return new Runner(cwd);
    }

    private makeLinuxRunner(cwd: string): IRunner {
        return new DockerRunner(cwd, path.join('scripts', 'in-docker.sh'));
    }

    private async buildWithRunner(
        runner: IRunner,
        buildVersion: string,
        type: Type,
    ): Promise<void> {
        await runner.run('yarn', 'install');
        await runner.run('yarn', 'run', 'hak', 'check');
        await runner.run('yarn', 'run', 'build:native');
        await runner.run('yarn', 'run', 'fetch', 'develop', '-d', 'element.io/nightly');
        await runner.run('yarn', 'build', '--config', ELECTRON_BUILDER_CFG_FILE);
    }

    private async buildWin(type: Type, buildVersion: string): Promise<void> {
        await fsProm.mkdir('builds', { recursive: true });
        const buildDirName = 'element-desktop-' + type + '-' + buildVersion;
        const repoDir = path.join('builds', buildDirName);
        await rm(repoDir);

        // we still check out the repo locally because we need package.json
        // to write the electron builder config file, so we check out the
        // repo twice for windows: once locally and once on the VM...
        const repo = new GitRepo(repoDir);
        await repo.clone(DESKTOP_GIT_REPO, repoDir);
        //await fsProm.mkdir(repoDir);
        await this.writeElectronBuilderConfigFile(type, repoDir, buildVersion);

        const builder = new WindowsBuilder(
            repoDir, type, this.winVmName, this.winUsername, this.winPassword, this.riotSigningKeyContainer,
        );

        logger.info("Starting Windows builder for " + type + '...');
        await builder.start();
        logger.info("...builder started");

        const electronBuilderArchFlag = type === Type.Windows64 ? '--x64' : '--ia32';

        try {
            builder.appendScript('rd', buildDirName, '/s', '/q');
            builder.appendScript('git', 'clone', DESKTOP_GIT_REPO, buildDirName);
            builder.appendScript('cd', buildDirName);
            builder.appendScript('copy', 'z:\\' + ELECTRON_BUILDER_CFG_FILE, ELECTRON_BUILDER_CFG_FILE);
            builder.appendScript('call', 'yarn', 'install');
            builder.appendScript('call', 'yarn', 'run', 'hak', 'check');
            builder.appendScript('call', 'yarn', 'run', 'build:native');
            builder.appendScript('call', 'yarn', 'run', 'fetch', 'develop', '-d', 'element.io\\nightly');
            builder.appendScript(
                'call', 'yarn', 'build', electronBuilderArchFlag, '--config', ELECTRON_BUILDER_CFG_FILE,
            );
            builder.appendScript('xcopy dist z:\\dist /S /I /Y');
            builder.appendScript('cd', '..');
            builder.appendScript('rd', buildDirName, '/s', '/q');

            logger.info("Starting build...");
            await builder.runScript();
            logger.info("Build complete!");

            const squirrelDir = 'squirrel-windows' + (type === Type.Windows32 ? '-ia32' : '');
            const archDir = type === Type.Windows32 ? 'ia32' : 'x64';

            await fsProm.mkdir(path.join(this.appPubDir, 'install', 'win32', archDir), { recursive: true });
            await fsProm.mkdir(path.join(this.appPubDir, 'update', 'win32', archDir), { recursive: true });

            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.exe$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'install', 'win32', archDir, 'Element Nightly Setup.exe'),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /\.nupkg$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                );
            }
            for (const f of await getMatchingFilesInDir(path.join(repoDir, 'dist', squirrelDir), /^RELEASES$/)) {
                await copyAndLog(
                    path.join(repoDir, 'dist', squirrelDir, f),
                    path.join(this.appPubDir, 'update', 'win32', archDir, f),
                );
            }

            // prune update packages (installers are overwritten each time)
            await pruneBuilds(path.join(this.appPubDir, 'update', 'win32', archDir), /\.nupkg$/);
        } finally {
            await builder.stop();
        }

        logger.info("Removing build dir");
        await rm(repoDir);
    }
}