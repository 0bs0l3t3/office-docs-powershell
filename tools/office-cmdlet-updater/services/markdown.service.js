const fs = require('fs-extra');
const path = require('path');
const Queue = require('better-queue');
const of = require('await-of').default;
const shortId = require('shortid');
const { markdownErrors } = require('../constants/errors');

class MarkdownService {
	constructor(
		powerShellService,
		logStoreService,
		logParseService,
		cmdletDependenciesService,
		config
	) {
		this.logStoreService = logStoreService;
		this.powerShellService = powerShellService;
		this.logParseService = logParseService;
		this.config = config;
		this.cds = cmdletDependenciesService;

		this.processQueue = this.processQueue.bind(this);
		this.copyMdInTempFolder = this.copyMdInTempFolder.bind(this);
		this.getLogFileContent = this.getLogFileContent.bind(this);
		this.queueFinishHandler = this.queueFinishHandler.bind(this);
		this.updateMd = this.updateMd.bind(this);
		this.addMdFilesInQueue = this.addMdFilesInQueue.bind(this);
		this.queueEmptyHandler = this.queueEmptyHandler.bind(this);
		this.queueFailedHandler = this.queueFailedHandler.bind(this);

		this.queue = new Queue(this.processQueue);
		this.queue.on('empty', this.queueEmptyHandler);

		this.installedDependencies = [];
	}

	async updateMd(doc) {
		return this.addMdFilesInQueue(doc);
	}

	async addMdFilesInQueue(doc) {
		const { ignoreFiles } = this.config.get('platyPS');
		const ignoreAbsolutePathsArr = ignoreFiles.map((f) => path.resolve(f));
		const metaTagRegex = /(?<=applicable: ).+/gmu;

		const isFileIgnore = (fileName) => {
			const absoluteFilePath = path.resolve(fileName);

			return ignoreAbsolutePathsArr.includes(absoluteFilePath);
		};

		const isContainTag = (filePath) => {
			if (!doc.metaTags.length) {
				return true;
			}

			const groups = fs
				.readFileSync(filePath, 'utf8')
				.toString()
				.match(metaTagRegex);

			if (!groups) {
				return false;
			}

			for (const metaTag of doc.metaTags) {
				if (groups[0].indexOf(metaTag) !== -1) {
					return true;
				}
			}

			return false;
		};

		const mdFiles = (await this._getMdFiles(doc.path)).filter(
			(fn) => !isFileIgnore(fn) && isContainTag(fn)
		);

		mdFiles.forEach((file) => {
			this.queue
				.push({ file, doc })
				.on('failed', this.queueFailedHandler)
				.on('finish', this.queueFinishHandler);
		});
	}

	async _getMdFiles(path) {
		const mdExt = '.md';

		const allFiles = await this._getFolderFiles(path);

		return allFiles.filter((file) => file.endsWith(mdExt));
	}

	async _getFolderFiles(folderPath) {
		const files = await fs.readdir(folderPath);

		return await files.reduce(async (promiseResult, filePath) => {
			const result = await promiseResult;
			const absolute = path.resolve(folderPath, filePath);

			const fileStat = await fs.stat(absolute);

			if (fileStat.isDirectory()) {
				const subDirFiles = await this._getFolderFiles(absolute);

				return [...result, ...subDirFiles];
			}

			return [...result, absolute];
		}, []);
	}

	async processQueue({ file, doc }, cb) {
		let result, err;

		const { name } = doc;

		if (!this.installedDependencies.includes(name)) {
			this.installedDependencies.push(name);

			await this.cds.installDependencies({ cmdletName: name });
		}

		const getTempFolderName = () => {
			let tempFolders = this.logStoreService.getAllTempFolders();

			if (!tempFolders.has(doc.name)) {
				const tempFolderPath = `${doc.path}\\${shortId()}`;

				this.logStoreService.addTempFolder(tempFolderPath, doc.name);

				tempFolders = this.logStoreService.getAllTempFolders();
			}

			return tempFolders.get(doc.name);
		};

		const [tempFolderPath] = getTempFolderName();
		const logFilePath = `${tempFolderPath}\\${shortId()}.log`;

		[result, err] = await of(this.copyMdInTempFolder(file, tempFolderPath));

		if (err) {
			return cb(err, null);
		}

		[result, err] = await of(
			this.powerShellService.updateMarkdown(result, logFilePath)
		);

		if (err) {
			console.error(err);

			this.logStoreService.addError(err, doc.name);

			return cb(null, '');
		}

		console.log(result); // print powershell command result

		[result, err] = await of(this.getLogFileContent(logFilePath));

		console.log(result); // print update file log

		if (err) {
			return cb(err, null);
		}

		return cb(null, { result, doc });
	}

	async queueFailedHandler(err) {
		throw new Error(err);
	}

	queueFinishHandler({ result, doc }) {
		if (!result) {
			return;
		}
		this.logStoreService.addLog(result, doc.name);
	}

	async queueEmptyHandler() {
		this.powerShellService.dispose();

		this.logStoreService.saveInFs();

		const tempFolders = [
			...this.logStoreService.getAllTempFolders().values()
		].map((path) => path[0]);

		for (const path of tempFolders) {
			if (fs.pathExists(path)) {
				const [, fsError] = await of(fs.remove(path));

				if (fsError) {
					throw new Error(fsError);
				}
			}
		}

		this.logParseService.parseAll();
	}

	async copyMdInTempFolder(srcFilePath, tempFolderPath) {
		let err;

		const fileName = path.basename(srcFilePath);
		const distFilePath = `${tempFolderPath}\\${fileName}`;

		[, err] = await of(fs.ensureDir(tempFolderPath));

		if (err) {
			throw new Error(markdownErrors.CANT_CREATE_TEMP_FOLDER);
		}

		[, err] = await of(fs.copy(srcFilePath, distFilePath));

		if (err) {
			throw new Error(markdownErrors.CANT_COPY_MD_FILE);
		}

		return distFilePath;
	}

	async getLogFileContent(logFilePath) {
		let err, result;

		[result, err] = await of(fs.ensureFile(logFilePath));

		if (result || err) {
			throw new Error(markdownErrors.CANT_OPEN_LOG_FILE);
		}

		return (await fs.readFile(logFilePath)).toString();
	}
}

module.exports = MarkdownService;
