import fs from "node:fs";

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function readJobUrls(url: string | undefined, jobsFile: string | undefined): string[] {
  const output: string[] = [];

  if (url) output.push(url.trim());

  if (jobsFile) {
    const fileUrls = fs
      .readFileSync(jobsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => Boolean(line) && !line.startsWith("#"));

    output.push(...fileUrls);
  }

  return [...new Set(output)];
}
