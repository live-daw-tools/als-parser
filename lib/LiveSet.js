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

export class LiveSet extends EventEmitter {
	#_raw
	#_parsed
	#_path
	#_fileinfo
	#_tempo
	#_samples = []
	#_trackInfo = {}

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

	// Static factory method that creates and reads in one step
	static async create(path) {
		const instance = new LiveSet(path, { autoInit: false })
		await instance.init()
		return instance
	}

	// Initialize the LiveSet (get file info and read)
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

	get tempo() {
		return this.#_tempo
	}

	get tracks() {
		this.#_trackInfo = this.getDeviceInfo()

		return this.#_trackInfo
	}

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

	get tempo() {
		return parseFloat(this.#_tempo).toFixed(2)
	}

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

	get parsed() {
		return this.#_parsed
	}

	// .tracks is straight from the parsed xml, here we're filtering down to just useful info about plugins and devices
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

export class LiveProject extends EventEmitter {
	#_directory
	#_valid
	liveSets = []
	liveSetPaths = []

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

	get isValid() {
		return this.#_valid
	}

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
