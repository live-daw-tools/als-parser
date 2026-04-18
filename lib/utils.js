/**
 * @module utils
 * @description Utility functions for reading, parsing, and searching Ableton Live project files.
 */

import { promises as fs } from 'node:fs'
import { createUnzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import xml2js from 'xml2js'
import path from 'node:path'
import { createReadStream } from 'fs'
import { createHash } from 'crypto'
import { EventEmitter } from 'node:events'
import _ from 'lodash-es'

const streamToBuffer = async (stream) => {
	const chunks = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return Buffer.concat(chunks)
}

/**
 * Recursively finds all paths in a nested object where a given key appears.
 *
 * @param {object} obj - The object to search.
 * @param {string} targetKey - The key to search for.
 * @param {string[]} [currentPath=[]] - The current path (used during recursion).
 * @returns {string[]} An array of dot-separated path strings where the key was found.
 */
export function findKeyPaths(obj, targetKey, currentPath = []) {
	const results = []

	if (obj === null || obj === undefined) {
		return results
	}

	// Check if current object has the target key
	if (typeof obj === 'object') {
		for (const key in obj) {
			if (key === targetKey) {
				// Found the target key, add the path
				results.push([...currentPath, key].join('.'))
			}

			// Recursively search in the value
			const value = obj[key]
			if (typeof value === 'object' && value !== null) {
				results.push(...findKeyPaths(value, targetKey, [...currentPath, key]))
			}
		}
	}

	return results
}

/**
 * Finds all paths to `SampleRef` keys in a parsed Ableton Live Set data object.
 *
 * @param {object} data - The parsed Live Set data object.
 * @returns {string[]} An array of dot-separated paths to each `SampleRef` occurrence.
 */
export function getSampleRefs(data) {
	const allResults = findKeyPaths(data, 'SampleRef')

	console.log('allResults', allResults)

	return allResults
}

/**
 * Reads and decompresses a gzip-compressed file (such as an `.als` file) into a UTF-8 string.
 *
 * @param {string} zipFilePath - The absolute or relative path to the gzip-compressed file.
 * @returns {Promise<string>} The decompressed file contents as a UTF-8 string.
 * @throws {Error} If the file cannot be read or decompressed.
 */
export async function readZipContents(zipFilePath) {
	try {
		// Read the zip file
		const zipData = await fs.readFile(zipFilePath)

		// Create unzip stream
		const unzip = createUnzip()
		const readableStream = Readable.from(zipData)

		// Pipe the zip data through the unzip stream
		const unzippedStream = readableStream.pipe(unzip)

		// Convert stream to buffer, then to string
		const unzippedBuffer = await streamToBuffer(unzippedStream)
		const contents = unzippedBuffer.toString('utf-8')

		return contents
	} catch (error) {
		throw new Error(`Error reading zip file: ${error.message}`)
	}
}

/**
 * Reads and decompresses a gzip-compressed file with streaming progress events.
 * Yields progress objects at each stage, then yields a `complete` event with the file contents.
 *
 * @param {string} zipFilePath - The absolute or relative path to the gzip-compressed file.
 * @yields {{ stage: string, percent: number, file: string, bytesRead: number, bytesTotal: number, data: string, error: string }}
 *   Progress events. The `complete` stage includes a `data` property with the full file contents.
 * @throws {Error} If the file cannot be read or decompressed.
 */
export async function* readZipContentsStreaming(zipFilePath) {
	try {
		yield { stage: 'reading', percent: 0, file: zipFilePath }

		const stats = await fs.stat(zipFilePath)
		const totalSize = stats.size
		const fileStream = createReadStream(zipFilePath)

		yield { stage: 'unzipping', percent: 25, bytesTotal: totalSize }

		const unzip = createUnzip()
		const unzippedStream = fileStream.pipe(unzip)

		const chunks = []
		let bytesRead = 0

		for await (const chunk of unzippedStream) {
			chunks.push(chunk)
			bytesRead += chunk.length
			// Progress from 25% to 95% during unzipping
			const progress = Math.min(95, 25 + (bytesRead / totalSize) * 70)
			yield {
				stage: 'processing',
				percent: progress,
				bytesRead,
				bytesTotal: totalSize,
			}
		}

		const contents = Buffer.concat(chunks).toString('utf-8')
		yield { stage: 'complete', percent: 100, data: contents }
		return contents
	} catch (error) {
		yield { stage: 'error', error: error.message }
		throw new Error(`Error reading zip file: ${error.message}`)
	}
}

/**
 * Parses an XML string into a JavaScript object using xml2js.
 *
 * @param {string} xmlString - The XML string to parse.
 * @returns {Promise<object>} The parsed JavaScript object.
 * @throws {Error} If the XML cannot be parsed.
 */
export async function parseXmlString(xmlString) {
	try {
		const parser = new xml2js.Parser({
			explicitArray: false, // Don't create arrays for single elements
			trim: true, // Trim whitespace
			explicitRoot: false, // Don't wrap the result in a root key
		})

		// Convert parser.parseString to a promise-based function
		const parseString = (data) => {
			return new Promise((resolve, reject) => {
				parser.parseString(data, (err, result) => {
					if (err) reject(err)
					else resolve(result)
				})
			})
		}

		const result = await parseString(xmlString)
		return result
	} catch (error) {
		throw new Error(`Error parsing XML: ${error.message}`)
	}
}

/**
 * Recursively searches a directory for Ableton Live Set (`.als`) files.
 *
 * @param {string} directoryPath - The root directory to search.
 * @param {{ backups: boolean }} [options] - Search options.
 * @param {boolean} [options.backups=false] - Whether to include files from `Backup` subdirectories.
 * @returns {Promise<string[]>} An array of absolute paths to all found `.als` files.
 */
export async function findAlsFiles(directoryPath, options) {
	const alsFiles = []
	let _directoryPath

	if (!path.isAbsolute(directoryPath)) {
		_directoryPath = path.normalize(process.cwd(), directoryPath)
	}

	if (!options) {
		options = { backups: false }
	}

	async function recursiveSearch(currentPath) {
		function isBackupFile(p) {
			let _fname = path.basename(p)
			let _dir = path.dirname(p).split(path.sep).pop()

			return _dir === 'Backup'
		}
		try {
			const entries = await fs.readdir(currentPath, { withFileTypes: true })

			for (const entry of entries) {
				const fullPath = path.join(currentPath, entry.name)

				if (entry.isDirectory()) {
					await recursiveSearch(fullPath)
				} else if (entry.isFile() && path.extname(entry.name) === '.als') {
					if (options.backups === false) {
						if (!isBackupFile(fullPath)) {
							alsFiles.push(path.resolve(fullPath))
						}
					} else {
						alsFiles.push(path.resolve(fullPath))
					}
				}
			}
		} catch (error) {
			console.error(`Error accessing ${currentPath}: ${error.message}`)
		}
	}

	await recursiveSearch(directoryPath)
	return alsFiles
}

/**
 * Recursively searches a directory for Ableton Live Set (`.als`) files with streaming progress events.
 * Yields a progress event for each directory scanned, each file found, and a `complete` event when done.
 *
 * @param {string} directoryPath - The root directory to search.
 * @param {{ backups: boolean }} [options] - Search options.
 * @param {boolean} [options.backups=false] - Whether to include files from `Backup` subdirectories.
 * @yields {{ type: string, path: string, file: string, depth: number, error: string }}
 *   Progress events. `found` events include a `file` property with the absolute path to the `.als` file.
 */
export async function* findAlsFilesStreaming(directoryPath, options) {
	let _directoryPath

	if (!path.isAbsolute(directoryPath)) {
		_directoryPath = path.normalize(process.cwd(), directoryPath)
	}

	if (!options) {
		options = { backups: false }
	}

	function isBackupFile(p) {
		let _dir = path.dirname(p).split(path.sep).pop()
		return _dir === 'Backup'
	}

	async function* recursiveSearch(currentPath, depth = 0) {
		yield {
			type: 'scanning',
			path: currentPath,
			depth,
		}

		try {
			const entries = await fs.readdir(currentPath, { withFileTypes: true })

			for (const entry of entries) {
				const fullPath = path.join(currentPath, entry.name)

				if (entry.isDirectory()) {
					yield* recursiveSearch(fullPath, depth + 1)
				} else if (entry.isFile() && path.extname(entry.name) === '.als') {
					const shouldInclude =
						options.backups === true || !isBackupFile(fullPath)
					if (shouldInclude) {
						yield {
							type: 'found',
							file: path.resolve(fullPath),
							depth,
						}
					}
				}
			}
		} catch (error) {
			yield {
				type: 'error',
				path: currentPath,
				error: error.message,
			}
		}
	}

	yield* recursiveSearch(directoryPath)
	yield { type: 'complete' }
}

async function calculateFileSha256(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256')
		const stream = createReadStream(filePath)

		stream.on('error', (error) => {
			reject(new Error(`Error reading file: ${error.message}`))
		})

		stream.on('data', (chunk) => {
			hash.update(chunk)
		})

		stream.on('end', () => {
			resolve(hash.digest('hex'))
		})
	})
}

/**
 * Returns file metadata and a SHA-256 hash for a given file path.
 *
 * @param {string} filePath - The path to the file.
 * @returns {Promise<{ name: string, path: string, size: number, sha256: string, created: number, modified: number }>}
 *   An object containing the file name, full path, size in bytes, SHA-256 hash, and creation/modification timestamps (milliseconds).
 * @throws {Error} If the file cannot be accessed or read.
 */
export async function getFileInfo(filePath) {
	try {
		const stats = await fs.stat(filePath)

		const hash = await calculateFileSha256(filePath)

		return {
			name: path.basename(filePath),
			path: filePath,
			size: stats.size,
			sha256: hash,
			created: stats.birthtimeMs,
			modified: stats.mtimeMs,
		}
	} catch (error) {
		throw new Error(`Error processing file: ${error.message}`)
	}
}

async function resolvePath(inputPath) {
	try {
		// Resolve the absolute path
		const absolutePath = path.resolve(inputPath)

		try {
			// Check if path exists
			await fs.access(absolutePath)
			return {
				original: inputPath,
				resolved: absolutePath,
				exists: true,
				isDirectory: (await fs.stat(absolutePath)).isDirectory(),
			}
		} catch {
			// Path doesn't exist
			return {
				original: inputPath,
				resolved: absolutePath,
				exists: false,
				isDirectory: null,
			}
		}
	} catch (error) {
		throw new Error(`Error processing path: ${error.message}`)
	}
}

/**
 * Validates whether a directory is a valid Ableton Live project.
 * A valid project must: be a directory, have a name ending with ` Project`,
 * contain at least one `.als` file, and contain an `Ableton Project Info` subfolder.
 *
 * @param {string} projectPath - The path to the directory to validate.
 * @returns {Promise<{isValid: boolean, path: string, name: string, errors: string[]}>}
 *   A validation result object. `name` is the project name (folder name without the ` Project` suffix).
 *   `errors` is present only when `isValid` is `false`.
 * @throws {Error} If an unexpected filesystem error occurs.
 */
export async function validateAbletonProject(projectPath) {
	// Resolve the absolute path
	const absolutePath = path.resolve(projectPath)
	try {
		// Check 1: Path exists and is a directory
		const stats = await fs.stat(absolutePath)
		if (!stats.isDirectory()) {
			return {
				isValid: false,
				path: absolutePath,
				errors: ['Path is not a directory'],
			}
		}

		const errors = []

		// Check 2: Folder name ends with ' Project'
		const folderName = path.basename(absolutePath)
		if (!folderName.endsWith(' Project')) {
			errors.push("Folder name does not end with ' Project'")
		}

		// Check 3: Contains .als files
		let hasAlsFiles = false
		let infoFolderExists = false

		const entries = await fs.readdir(absolutePath, { withFileTypes: true })

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.als')) {
				hasAlsFiles = true
			}
			if (entry.isDirectory() && entry.name === 'Ableton Project Info') {
				infoFolderExists = true
			}
		}

		if (!hasAlsFiles) {
			errors.push('No .als files found in directory')
		}

		// Check 4: Contains 'Ableton Project Info' folder
		if (!infoFolderExists) {
			errors.push("'Ableton Project Info' folder not found")
		}

		return {
			isValid: errors.length === 0,
			path: absolutePath,
			name: folderName.split(' Project').shift(),
			errors: errors.length > 0 ? errors : undefined,
		}
	} catch (error) {
		if (error.code === 'ENOENT') {
			return {
				isValid: false,
				path: absolutePath,
				errors: ['Path does not exist'],
			}
		}
		throw new Error(`Error validating project: ${error.message}`)
	}
}

/**
 * Recursively searches a root directory for valid Ableton Live projects.
 *
 * @param {string} rootPath - The root directory to search.
 * @returns {Promise<{ valid: object[], invalid: object[] }>}
 *   An object with `valid` and `invalid` arrays of validation result objects (see {@link validateAbletonProject}).
 */
export async function findAbletonProjects(rootPath) {
	const projects = {
		valid: [],
		invalid: [],
	}

	async function recursiveSearch(currentPath) {
		try {
			const entries = await fs.readdir(currentPath, { withFileTypes: true })

			for (const entry of entries) {
				const fullPath = path.join(currentPath, entry.name)

				if (entry.isDirectory()) {
					if (entry.name.endsWith(' Project')) {
						// Validate the potential Ableton project
						const validation = await validateAbletonProject(fullPath)
						if (validation.isValid) {
							projects.valid.push(validation)
						} else {
							projects.invalid.push(validation)
						}
					} else {
						// Recursively search other directories
						await recursiveSearch(fullPath)
					}
				}
			}
		} catch (error) {
			console.error(`Error accessing ${currentPath}: ${error.message}`)
		}
	}

	await recursiveSearch(path.resolve(rootPath))
	return projects
}

/**
 * Recursively searches a root directory for Ableton Live projects with streaming progress events.
 * Yields a progress event for each directory scanned, each project validated, and a `complete` event when done.
 *
 * @param {string} rootPath - The root directory to search.
 * @yields {{ type: string, path: string, project: object, isValid: boolean, depth: number, error: string }}
 *   Progress events. `project-found` events include a `project` property with the validation result object.
 */
export async function* findAbletonProjectsStreaming(rootPath) {
	async function* recursiveSearch(currentPath, depth = 0) {
		yield {
			type: 'scanning',
			path: currentPath,
			depth,
		}

		try {
			const entries = await fs.readdir(currentPath, { withFileTypes: true })

			for (const entry of entries) {
				const fullPath = path.join(currentPath, entry.name)

				if (entry.isDirectory()) {
					if (entry.name.endsWith(' Project')) {
						// Validate the potential Ableton project
						yield { type: 'validating', path: fullPath }
						const validation = await validateAbletonProject(fullPath)

						if (validation.isValid) {
							yield {
								type: 'project-found',
								project: validation,
								isValid: true,
							}
						} else {
							yield {
								type: 'project-found',
								project: validation,
								isValid: false,
							}
						}
					} else {
						// Recursively search other directories
						yield* recursiveSearch(fullPath, depth + 1)
					}
				}
			}
		} catch (error) {
			yield {
				type: 'error',
				path: currentPath,
				error: error.message,
			}
		}
	}

	yield* recursiveSearch(path.resolve(rootPath))
	yield { type: 'complete' }
}

// Utility function to find all properties by key in a nested object

/**
 * Recursively finds all properties matching any of the given keys within a nested object or array.
 *
 * @param {object|Array} obj - The object or array to search.
 * @param {string[]} targetKeys - The list of keys to find.
 * @param {string} [currentPath=''] - The current dot-separated path (used during recursion).
 * @param {Array<{ key: string, path: string, value: * }>} [results=[]] - Accumulator for results (used during recursion).
 * @returns {Array<{ key: string, path: string, value: * }>} An array of match objects with `key`, `path`, and `value`.
 */
export function findPropertiesByKey(
	obj,
	targetKeys,
	currentPath = '',
	results = [],
) {
	// Handle arrays
	if (Array.isArray(obj)) {
		obj.forEach((item, index) => {
			findPropertiesByKey(item, targetKeys, `${currentPath}[${index}]`, results)
		})
	}
	// Handle objects
	else if (obj !== null && typeof obj === 'object') {
		for (const key in obj) {
			const newPath = currentPath ? `${currentPath}.${key}` : key

			// Check if this key matches one of our target keys
			if (targetKeys.includes(key)) {
				results.push({
					key: key,
					path: newPath,
					value: obj[key],
				})
			}

			// Recurse into nested structures
			findPropertiesByKey(obj[key], targetKeys, newPath, results)
		}
	}
	return results
}

/**
 * Extracts the `Value` attribute from a parsed xml2js object of the form `{ $: { Value: ... } }`.
 *
 * @param {{ $: { Value: * } }} obj - The xml2js-parsed attribute object.
 * @returns {*} The value of the `Value` attribute.
 * @throws {Error} If the object does not have the expected structure.
 */
export function getValue(obj) {
	if (_.has(obj, '$.Value')) {
		return obj['$']?.Value
	} else {
		throw new Error(
			'Unexpected object structure: ' + JSON.stringify(obj, null, '  '),
		)
	}
}

/**
 * A mapping from xml2js plugin descriptor key names to human-readable plugin type strings.
 *
 * @type {{ AuPluginInfo: string, VstPluginInfo: string, Vst3PluginInfo: string }}
 */
export const pluginTypes = {
	AuPluginInfo: 'AU',
	VstPluginInfo: 'VST',
	Vst3PluginInfo: 'VST3',
}

/**
 * Extracts plugin type and info from a parsed `PluginDesc` xml2js object.
 *
 * @param {object} PluginDesc - The parsed `PluginDesc` object from the Live Set XML.
 * @returns {Array} A tuple `[pluginType, pluginInfo]`, or an empty array if the plugin type is unrecognized.
 *   `pluginType` is one of `'AU'`, `'VST'`, or `'VST3'`.
 *   `pluginInfo` is `{ name: string, manufacturer: string|null, path: string|null }`.
 */
export function getPluginInfo(PluginDesc) {
	let _keys = _.keys(PluginDesc)

	if (_keys.includes('AuPluginInfo')) {
		return [pluginTypes.AuPluginInfo, getAuPluginInfo(PluginDesc)]
	} else if (_keys.includes('VstPluginInfo')) {
		return [pluginTypes.VstPluginInfo, getVstPluginInfo(PluginDesc)]
	} else if (_keys.includes('Vst3PluginInfo')) {
		return [pluginTypes.Vst3PluginInfo, getVst3PluginInfo(PluginDesc)]
	}

	return [] // wtf? clap??
}

/**
 * Extracts plugin info from a parsed AU (Audio Unit) plugin descriptor.
 *
 * @param {object} PluginDesc - The parsed `PluginDesc` object containing an `AuPluginInfo` key.
 * @returns {{ name: string, manufacturer: string, path: null }} The AU plugin's name, manufacturer, and path (always null).
 */
export function getAuPluginInfo(PluginDesc) {
	let auInfo = PluginDesc.AuPluginInfo
	return {
		name: getValue(auInfo.Name),
		manufacturer: getValue(auInfo.Manufacturer),
		path: null,
	}
}

/**
 * Extracts plugin info from a parsed VST2 plugin descriptor.
 *
 * @param {object} PluginDesc - The parsed `PluginDesc` object containing a `VstPluginInfo` key.
 * @returns {{ name: string, manufacturer: null, path: string }} The VST2 plugin's name, path, and manufacturer (always null).
 */
export function getVstPluginInfo(PluginDesc) {
	let vstInfo = PluginDesc.VstPluginInfo

	return {
		name: getValue(vstInfo.PlugName),
		manufacturer: null,
		path: getValue(vstInfo.Path),
	}
}

/**
 * Extracts plugin info from a parsed VST3 plugin descriptor.
 *
 * @param {object} PluginDesc - The parsed `PluginDesc` object containing a `Vst3PluginInfo` key.
 * @returns {{ name: string, path: null, manufacturer: null }} The VST3 plugin's name, path (always null), and manufacturer (always null).
 */
export function getVst3PluginInfo(PluginDesc) {
	let vst3Info = PluginDesc.Vst3PluginInfo

	return {
		name: getValue(vst3Info.Name),
		path: null,
		manufacturer: null,
	}
}
