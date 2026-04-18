/**
 * @module LiveSet
 * @description Classes for loading and introspecting Ableton Live Set (.als) files and project directories.
 */

import {
	parseXmlString,
	readZipContents,
	readZipContentsStreaming,
	getFileInfo,
	findAlsFiles,
	findAlsFilesStreaming,
	validateAbletonProject,
	findPropertiesByKey,
	getValue,
	getPluginInfo,
} from './utils.js'
import path from 'node:path'

import { stat, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { EventEmitter } from 'node:events'
export {
	findAlsFiles,
	findAlsFilesStreaming,
	findAbletonProjects,
	findAbletonProjectsStreaming,
	readZipContentsStreaming,
} from './utils.js'
import _ from 'lodash-es'

function dumpData(object, key) {
	let str = JSON.stringify(object, null, ' ')
	writeFileSync(`./tmp/${key}.json`, str)
}

/**
 * Represents an Ableton Live Set (`.als`) file.
 * Extends `EventEmitter` to emit progress events during loading and parsing.
 *
 * Emits the following `progress` events (as `{ stage, percent, ... }`):
 * - `reading-file` – file read has started
 * - `unzipping` / `processing` – decompression in progress (0–50%)
 * - `parsing-xml` – XML parsing has started (50%)
 * - `parsing-complete` – XML parsing is complete (70%)
 * - `samples-extracted` – sample references have been extracted (80%)
 * - `complete` – loading is fully complete (100%)
 * - `error` – an error occurred; includes an `error` property
 *
 * @extends EventEmitter
 *
 * @example
 * // Preferred: use the static factory method
 * const liveSet = await LiveSet.create('/path/to/set.als')
 * console.log(liveSet.info)
 */
export class LiveSet extends EventEmitter {
	#_raw
	#_parsed
	#_path
	#_fileinfo
	#_tempo
	#_samples = []
	#_trackInfo = {}

	/**
	 * Creates a new LiveSet instance and optionally auto-initializes it.
	 *
	 * @param {string} path - The path to the `.als` file.
	 * @param {{ autoInit: boolean }} [options={}] - Options object.
	 * @param {boolean} [options.autoInit=true] - If `false`, skips automatic initialization.
	 *   Use `false` when you need to attach event listeners before calling `init()`.
	 * @returns {LiveSet|Promise<LiveSet>} Returns a `Promise<LiveSet>` when `autoInit` is `true` (default),
	 *   or the uninitialized `LiveSet` instance when `autoInit` is `false`.
	 */
	constructor(path, options = {}) {
		super()
		this.#_path = path
		this.initialized = false

		// If autoInit is false, don't auto-initialize (for streaming use case)
		if (options.autoInit === false) {
			return this
		}

		// Default behavior: auto-initialize (backward compatible)
		return (async () => {
			await this.init()
			return this
		})()
	}

	/**
	 * Static factory method that creates and fully initializes a `LiveSet` in one step.
	 * Preferred over `new LiveSet(path)` for async/await workflows.
	 *
	 * @param {string} path - The path to the `.als` file.
	 * @returns {Promise<LiveSet>} The initialized `LiveSet` instance.
	 */
	static async create(path) {
		const instance = new LiveSet(path, { autoInit: false })
		await instance.init()
		return instance
	}

	/**
	 * Initializes the LiveSet by loading file metadata and parsing the `.als` file contents.
	 * Called automatically by the constructor unless `autoInit` is `false`.
	 *
	 * @returns {Promise<LiveSet>} The initialized `LiveSet` instance.
	 */
	async init() {
		this.#_fileinfo = await getFileInfo(this.#_path)
		await this.read()
		return this
	}

	async read() {
		try {
			this.emit('progress', {
				stage: 'reading-file',
				percent: 0,
				path: this.#_path,
			})

			// Use streaming version for progress reporting
			for await (const event of readZipContentsStreaming(this.#_path)) {
				if (event.stage === 'complete') {
					this.#_raw = event.data
				} else if (event.stage === 'error') {
					this.emit('progress', { stage: 'error', error: event.error })
				} else {
					// Emit unzipping progress (0-50%)
					this.emit('progress', {
						stage: event.stage,
						percent: event.percent * 0.5,
						bytesRead: event.bytesRead,
						bytesTotal: event.bytesTotal,
					})
				}
			}
		} catch (e) {
			this.emit('progress', { stage: 'error', error: e.message })
			console.error('Error reading project file', e)
			throw new Error(`Error reading project file: ${this._path}`)
		}

		try {
			this.emit('progress', { stage: 'parsing-xml', percent: 50 })
			this.#_parsed = await parseXmlString(this.#_raw)

			this.emit('progress', { stage: 'parsing-complete', percent: 70 })
		} catch (e) {
			this.emit('progress', { stage: 'error', error: e.message })
			console.error('Error parsing xml', e)
			throw new Error(`Error parsing xml: ${this._path}`)
		}

		// Live 12.something changed from MasterTrack to MainTrack
		// TODO: some sort of abstraction for different versions?
		// need to investigate how often this happens

		if (
			_.has(this.#_parsed, 'LiveSet.MasterTrack.DeviceChain.Mixer.Tempo.Manual')
		) {
			this.#_tempo =
				this.#_parsed.LiveSet.MasterTrack.DeviceChain.Mixer.Tempo.Manual[
					'$'
				].Value
		} else if (
			_.has(this.#_parsed, 'LiveSet.MainTrack.DeviceChain.Mixer.Tempo.Manual')
		) {
			this.#_tempo =
				this.#_parsed.LiveSet.MainTrack.DeviceChain.Mixer.Tempo.Manual[
					'$'
				].Value
		} else {
			this.#_tempo = 'NaN'
		}

		// TODO: extract more useful info here

		// 1. all audio files used in the set (with paths) SampleRef

		let sampleRefs = findPropertiesByKey(this.#_parsed, ['SampleRef'])

		this.#_samples = sampleRefs.map((sampleRef) =>
			this.getSampleInfo(sampleRef),
		)

		this.emit('progress', { stage: 'samples-extracted', percent: 80 })

		// 2. create a structure of all tracks that includes devices / plugins used

		// 3. a reduced list of unique plugins used in the set

		this.initialized = true
		this.emit('progress', { stage: 'complete', percent: 100 })
	}

	/**
	 * An object keyed by track type (e.g. `AudioTrack`, `MidiTrack`) where each value is an
	 * array of track info objects containing `name`, `devices`, and `plugins`.
	 *
	 * @type {object}
	 */
	get tracks() {
		this.#_trackInfo = this.getDeviceInfo()

		return this.#_trackInfo
	}

	/**
	 * The total number of audio and MIDI tracks in the Live Set.
	 *
	 * @type {number}
	 */
	get trackCount() {
		// return this._parsed.tracks.track.length
		let _tracks = this.#_parsed.LiveSet.Tracks
		let count = 0

		if ('AudioTrack' in _tracks && _tracks['AudioTrack'].length > 0) {
			count += _tracks['AudioTrack'].length
		}

		if ('MidiTrack' in _tracks && _tracks['MidiTrack'].length > 0) {
			count += _tracks['MidiTrack'].length
		}

		return count
	}

	/**
	 * The Ableton Live version that created this Live Set.
	 *
	 * @type {{ app: string, major: number, minor: number, patch: number }}
	 */
	get version() {
		let regex = /([a-zA-Z\ ]+)\ ([0-9]+)\.([\d]+)(?:\.([\d]+))?/
		let pieces = regex.exec(this.#_parsed['$'].Creator)

		// console.log('Creator', this.#_parsed['$'].Creator, pieces)

		return {
			app: pieces[1],
			major: parseInt(pieces[2]),
			minor: parseInt(pieces[3]),
			patch: parseInt(pieces[4]) || 0,
		}
	}

	/**
	 * The project tempo formatted to two decimal places (e.g. `"120.00"`).
	 *
	 * @type {string}
	 */
	get tempo() {
		return parseFloat(this.#_tempo).toFixed(2)
	}

	/**
	 * A summary object containing the most useful information about the Live Set.
	 *
	 * @type {{ name: string, tempo: string, version: object, tracks: object, trackCount: number, location: string, path: string, size: number, sha256: string, created: number, modified: number }}
	 */
	get info() {
		return {
			name: this.#_fileinfo.name,
			tempo: this.tempo,
			version: this.version,
			tracks: this.tracks,
			trackCount: this.trackCount,
			location: this.location,
			...this.#_fileinfo,
		}
	}

	/**
	 * The raw parsed JavaScript object produced by xml2js from the Live Set XML.
	 *
	 * @type {object}
	 */
	get parsed() {
		return this.#_parsed
	}

	/**
	 * Builds and returns a structured summary of all tracks, including their devices and plugins.
	 * Filters the raw parsed XML down to useful track info.
	 *
	 * @returns {object} An object keyed by track type, where each value is an array of
	 *   `{ name: string, devices: string[], plugins: Array }` objects.
	 */
	getDeviceInfo() {
		let _tracks = this.#_parsed.LiveSet.Tracks
		let trackTypes = _.keys(_tracks)

		trackTypes.forEach((type) => {
			// console.log(`Type: ${type} has ${tracks[type].length} tracks:`)
			// console.log(type, _.isArray(this.tracks[type]))

			this.#_trackInfo[type] = []

			if (_.isArray(_tracks[type])) {
				_tracks[type].forEach((track) => {
					//
					let plugins = findPropertiesByKey(track, ['PluginDesc']).map(
						(pluginEntry) => {
							return getPluginInfo(pluginEntry.value)
						},
					)

					let _devices = this.getDevicesFromTrack(track)

					this.#_trackInfo[type].push({
						name: getValue(track.Name.EffectiveName),
						devices: _devices,
						plugins: plugins,
					})
				})
			} else {
				let plugins = findPropertiesByKey(_tracks[type], ['PluginDesc'])
				this.#_trackInfo[type] = plugins.map((pluginEntry) =>
					getPluginInfo(pluginEntry.value),
				)
				let devices = this.getDevicesFromTrack(_tracks[type])
			}
		})

		return this.#_trackInfo
	}

	/**
	 * Returns the list of device type names used in a given track.
	 *
	 * @param {object} track - A parsed track object from the Live Set XML.
	 * @returns {string[]} An array of device type name strings (e.g. `['Compressor2', 'Reverb']`).
	 */
	getDevicesFromTrack(track) {
		// XXX need to grep out all devices recursively here
		let results = findPropertiesByKey(track, ['Devices'])
		let devices = results.map((entry) => entry.value)
		let out = []
		devices.forEach((device) => {
			// console.log('XXX device', _.keys(device))
			out.push(_.keys(device))
		})
		return _.flatten(out)
	}

	/**
	 * Extracts sample info from a parsed `SampleRef` entry.
	 *
	 * @param {{ key: string, path: string, value: object }} sampleRef - A match object from {@link findPropertiesByKey}.
	 * @returns {{ path: string, size: string, type: string } | 'external'}
	 *   An object with the sample path, file size, and type (e.g. `'recorded'`, `'imported'`),
	 *   or the string `'external'` if the sample is outside the project folder.
	 */
	getSampleInfo(sampleRef) {
		// console.log('SampleRef info:', sampleRef.value.FileRef)
		let _path = getValue(sampleRef.value.FileRef.Path)

		let type = 'unknown'

		let parts = _path.split(path.sep)
		let projectRoot = _.slice(parts, -4)[0]

		if (['Samples'].includes(projectRoot)) {
			projectRoot = _.slice(parts, -5)[0]
		}

		// console.log('projectRoot', projectRoot)

		if (projectRoot.endsWith(' Project')) {
			type = _.slice(parts, -2)[0].toLowerCase()
		} else {
			return 'external'
		}

		return {
			path: _path,
			size: sampleRef.value.FileRef.OriginalFileSize['$'].Value,
			type,
		}
	}
}

/**
 * Represents an Ableton Live project directory.
 * Validates the directory structure and discovers `.als` files within the project.
 * Extends `EventEmitter` to emit progress events when loading sets.
 *
 * Emits the following events:
 * - `progress` – overall project loading progress (`{ stage, completed, total, percent }`)
 * - `set-progress` – per-set progress events forwarded from each `LiveSet` (`{ path, setIndex, ...event }`)
 *
 * @extends EventEmitter
 *
 * @example
 * const project = await new LiveProject('/path/to/My Song Project')
 * console.log(project.name)      // "My Song"
 * console.log(project.liveSetPaths)
 *
 * await project.loadSets()
 * console.log(project.liveSets[0].info)
 */
export class LiveProject extends EventEmitter {
	#_directory
	#_valid
	liveSets = []
	liveSetPaths = []

	/**
	 * Creates and validates a new `LiveProject` instance.
	 * Returns a `Promise<LiveProject>` because project validation is asynchronous.
	 *
	 * @param {string} directory - The path to the Ableton Live project directory.
	 * @returns {Promise<LiveProject>} The initialized `LiveProject` instance.
	 * @throws {string} If the directory is not a valid Ableton Live project.
	 */
	constructor(directory) {
		super()
		this.#_directory = directory
		this.path = false
		this.name = false

		return (async () => {
			// async code goes here
			let _result = await validateAbletonProject(directory)
			if (_result.isValid !== true) {
				throw `Directory ${directory} isn't an Ableton project:\n ${_result.errors.join(
					'\n',
				)}`
			}
			this.#_valid = true
			this.path = _result.path
			this.name = _result.name

			this.liveSetPaths = await findAlsFiles(this.#_directory, {
				backups: false,
			})

			return this
		})()
	}

	/**
	 * Whether the project directory passed validation.
	 *
	 * @type {boolean}
	 */
	get isValid() {
		return this.#_valid
	}

	/**
	 * Loads all `LiveSet` instances for each `.als` file found in the project directory.
	 * Populates `this.liveSets` with initialized `LiveSet` objects.
	 * Emits `progress` and `set-progress` events during loading.
	 *
	 * @returns {Promise<true>} Resolves to `true` when all sets are loaded.
	 */
	async loadSets() {
		const total = this.liveSetPaths.length
		let completed = 0

		this.emit('progress', {
			stage: 'loading-sets',
			completed: 0,
			total,
			percent: 0,
		})

		for (const setPath of this.liveSetPaths) {
			// Create LiveSet instance without auto-init to attach listeners first
			const liveSet = new LiveSet(setPath, { autoInit: false })

			// Attach event listeners before initialization
			liveSet.on('progress', (event) => {
				this.emit('set-progress', {
					path: setPath,
					setIndex: completed,
					...event,
				})
			})

			// Now initialize (read file info and parse)
			await liveSet.init()

			this.liveSets.push(liveSet)
			completed++

			this.emit('progress', {
				stage: 'loading-sets',
				completed,
				total,
				percent: (completed / total) * 100,
			})
		}

		this.emit('progress', {
			stage: 'complete',
			completed: total,
			total,
			percent: 100,
		})

		return true
	}
}
