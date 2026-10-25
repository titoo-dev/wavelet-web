import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
} from "fs";
import { HTTPError, ReadError, TimeoutError, default as got } from "got";
import { tmpdir } from "os";
import type { StorageProvider } from "../storage/StorageProvider";
import { OverwriteOption } from "../settings";
import { USER_AGENT_HEADER, pipeline } from "../utils/index";

const TEMPDIR = tmpdir() + "/wavelet-imgs";
mkdirSync(TEMPDIR, { recursive: true });

const MAX_IMAGE_RETRIES = 3;

export async function downloadImage(
	url: string,
	path: string,
	overwrite = OverwriteOption.DONT_OVERWRITE,
	storageProvider?: StorageProvider
) {
	if (storageProvider) {
		return downloadImageWithProvider(url, path, overwrite, storageProvider);
	}
	return downloadImageLocal(url, path, overwrite);
}

async function downloadImageWithProvider(
	url: string,
	path: string,
	overwrite: string,
	storageProvider: StorageProvider,
	_retryCount = 0
) {
	if (
		(await storageProvider.exists(path)) &&
		![
			OverwriteOption.OVERWRITE,
			OverwriteOption.ONLY_TAGS,
			OverwriteOption.KEEP_BOTH,
		].includes(overwrite)
	) {
		const file = await storageProvider.readFile(path);
		if (file.length !== 0) return path;
		await storageProvider.deleteFile(path);
	}

	let timeout: NodeJS.Timeout | null = null;
	let error = "";

	const downloadStream = got
		.stream(url, {
			headers: { "User-Agent": USER_AGENT_HEADER },
		})
		.on("data", function () {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				error = "DownloadTimeout";
				downloadStream.destroy();
			}, 5000);
		});

	const fileWriterStream = storageProvider.createWriteStream(path);

	timeout = setTimeout(() => {
		error = "DownloadTimeout";
		downloadStream.destroy();
	}, 5000);

	try {
		await pipeline(downloadStream, fileWriterStream);
		await storageProvider.finalizeStream(path);
	} catch (e: unknown) {
		await storageProvider.deleteFile(path);
		if (e instanceof HTTPError) {
			if (url.includes("images.dzcdn.net")) {
				const urlBase = url.slice(0, url.lastIndexOf("/") + 1);
				const pictureURL = url.slice(urlBase.length);
				const pictureSize = parseInt(
					pictureURL.slice(0, pictureURL.indexOf("x"))
				);
				if (pictureSize > 1200) {
					return downloadImageWithProvider(
						urlBase +
							pictureURL.replace(`${pictureSize}x${pictureSize}`, "1200x1200"),
						path,
						overwrite,
						storageProvider
					);
				}
			}
			return null;
		}
		if (
			e instanceof ReadError ||
			e instanceof TimeoutError ||
			[
				"ESOCKETTIMEDOUT",
				"ERR_STREAM_PREMATURE_CLOSE",
				"ETIMEDOUT",
				"ECONNRESET",
			].includes((e as { code?: string }).code) ||
			(downloadStream.destroyed && error === "DownloadTimeout")
		) {
			if (_retryCount >= MAX_IMAGE_RETRIES) return null;
			return downloadImageWithProvider(url, path, overwrite, storageProvider, _retryCount + 1);
		}
		console.trace(e);
		throw e;
	}
	return path;
}

async function downloadImageLocal(
	url: string,
	path: string,
	overwrite: string,
	_retryCount = 0
) {
	if (
		existsSync(path) &&
		![
			OverwriteOption.OVERWRITE,
			OverwriteOption.ONLY_TAGS,
			OverwriteOption.KEEP_BOTH,
		].includes(overwrite)
	) {
		const file = readFileSync(path);
		if (file.length !== 0) return path;
		unlinkSync(path);
	}
	let timeout: NodeJS.Timeout | null = null;
	let error = "";

	const downloadStream = got
		.stream(url, {
			headers: { "User-Agent": USER_AGENT_HEADER },
		})
		.on("data", function () {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				error = "DownloadTimeout";
				downloadStream.destroy();
			}, 5000);
		});
	const fileWriterStream = createWriteStream(path);

	timeout = setTimeout(() => {
		error = "DownloadTimeout";
		downloadStream.destroy();
	}, 5000);

	try {
		await pipeline(downloadStream, fileWriterStream);
	} catch (e: unknown) {
		unlinkSync(path);
		if (e instanceof HTTPError) {
			if (url.includes("images.dzcdn.net")) {
				const urlBase = url.slice(0, url.lastIndexOf("/") + 1);
				const pictureURL = url.slice(urlBase.length);
				const pictureSize = parseInt(
					pictureURL.slice(0, pictureURL.indexOf("x"))
				);
				if (pictureSize > 1200) {
					return downloadImageLocal(
						urlBase +
							pictureURL.replace(`${pictureSize}x${pictureSize}`, "1200x1200"),
						path,
						overwrite
					);
				}
			}
			return null;
		}
		if (
			e instanceof ReadError ||
			e instanceof TimeoutError ||
			[
				"ESOCKETTIMEDOUT",
				"ERR_STREAM_PREMATURE_CLOSE",
				"ETIMEDOUT",
				"ECONNRESET",
			].includes((e as { code?: string }).code) ||
			(downloadStream.destroyed && error === "DownloadTimeout")
		) {
			if (_retryCount >= MAX_IMAGE_RETRIES) return null;
			return downloadImageLocal(url, path, overwrite, _retryCount + 1);
		}
		console.trace(e);
		throw e;
	}
	return path;
}
