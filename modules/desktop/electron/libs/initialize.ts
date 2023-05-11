import fs from "fs";
import { getTeaPath } from "./tea-dir";
import { authFileState } from "./auth";
import * as https from "https";
import { spawn } from "child_process";
import path from "path";
import { parse as semverParse } from "@tea/libtea";

type InitState = "NOT_INITIALIZED" | "PENDING" | "INITIALIZED";

export class InitWatcher<T> {
  private initState: InitState;
  private initFunction: () => Promise<T>;
  private initializationPromise: Promise<T> | undefined;

  constructor(initFunction: () => Promise<T>) {
    this.initState = "NOT_INITIALIZED";
    this.initFunction = initFunction;
    this.initializationPromise = undefined;
  }

  async initialize(): Promise<T> {
    if (this.initState === "NOT_INITIALIZED") {
      this.initState = "PENDING";
      this.initializationPromise = this.retryFunction(this.initFunction, 3)
        .then((value) => {
          this.initState = "INITIALIZED";
          return value;
        })
        .catch((error) => {
          this.initState = "NOT_INITIALIZED";
          this.initializationPromise = undefined;
          throw error;
        });
    }

    return this.initializationPromise as Promise<T>;
  }

  async retryFunction(func: () => Promise<T>, retries: number, currentAttempt = 1): Promise<T> {
    try {
      const result = await func();
      return result;
    } catch (error) {
      if (currentAttempt < retries) {
        return this.retryFunction(func, retries, currentAttempt + 1);
      } else {
        throw error;
      }
    }
  }

  reset(): void {
    this.initState = "NOT_INITIALIZED";
    this.initializationPromise = undefined;
  }

  async observe(): Promise<T> {
    return await this.initialize();
  }

  getState(): InitState {
    return this.initState;
  }
}

// Be careful with globbing when passing this to a shell which might expand it.  Either escape it or quote it.
const teaCliPrefix = path.join(getTeaPath(), "tea.xyz/v*");

export const cliInitializationState = new InitWatcher<string>(async () => {
  if (!fs.existsSync(path.join(teaCliPrefix, "bin/tea"))) {
    return installTeaCli();
  } else {
    const dir = fs.readlinkSync(teaCliPrefix);
    const v = semverParse(dir)?.toString();
    if (!v) throw new Error(`couldn't parse to semver: ${dir}`);
    return v;
  }
});

cliInitializationState.initialize();

export async function initializeTeaCli(): Promise<string> {
  if (
    cliInitializationState.getState() === "INITIALIZED" &&
    !fs.existsSync(path.join(teaCliPrefix, "bin/tea"))
  ) {
    cliInitializationState.reset();
  }
  return cliInitializationState.observe();
}

//NOTE copy pasta from https://github.com/teaxyz/setup/blob/main/action.js
//FIXME ideally we'd not copy pasta this
//NOTE using `tar` is not ideal ∵ Windows and even though tar is POSIX it's still not guaranteed to be available
async function installTeaCli() {
  const PREFIX = `${process.env.HOME}/.tea`;

  const midfix = (() => {
    switch (process.arch) {
      case "arm64":
        return `${process.platform}/aarch64`;
      case "x64":
        return `${process.platform}/x86-64`;
      default:
        throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
    }
  })();

  /// versions.txt is guaranteed semver-sorted
  const v: string | undefined = await new Promise((resolve, reject) => {
    https
      .get(`https://dist.tea.xyz/tea.xyz/${midfix}/versions.txt`, (rsp) => {
        if (rsp.statusCode != 200) return reject(rsp.statusCode);
        rsp.setEncoding("utf8");
        const chunks: string[] = [];
        rsp.on("data", (x) => chunks.push(x));
        rsp.on("end", () => {
          resolve(chunks.join("").trim().split("\n").at(-1));
        });
      })
      .on("error", reject);
  });

  if (!v) throw new Error(`invalid versions.txt for tea/cli`);

  fs.mkdirSync(PREFIX, { recursive: true });

  const exitcode = await new Promise((resolve, reject) => {
    https
      .get(`https://dist.tea.xyz/tea.xyz/${midfix}/v${v}.tar.gz`, (rsp) => {
        if (rsp.statusCode != 200) return reject(rsp.statusCode);
        const tar = spawn("tar", ["xzf", "-"], {
          stdio: ["pipe", "inherit", "inherit"],
          cwd: PREFIX
        });
        rsp.pipe(tar.stdin);
        tar.on("close", resolve);
      })
      .on("error", reject);
  });

  if (exitcode != 0) {
    throw new Error(`tar: ${exitcode}`);
  }

  const oldwd = process.cwd();
  process.chdir(`${PREFIX}/tea.xyz`);
  if (fs.existsSync(`v*`)) fs.unlinkSync(`v*`);
  fs.symlinkSync(`v${v}`, `v*`, "dir");
  if (fs.existsSync(`v0`)) fs.unlinkSync(`v0`);
  fs.symlinkSync(`v${v}`, `v0`, "dir"); //FIXME
  process.chdir(oldwd);

  return v;
}

export default async function initialize(): Promise<string> {
  const [version] = await Promise.all([initializeTeaCli(), authFileState.observe()]);
  return version;
}
