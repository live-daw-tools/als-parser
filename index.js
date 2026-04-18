/**
 * @module als-parser
 * @description An experimental parser for Ableton Live Set files (`.als`) that extracts
 * information about tracks, clips, and devices.
 *
 * @example
 * import { LiveSet, LiveProject } from '@live-daw-tools/als-parser'
 *
 * // Load a single .als file
 * const liveSet = await LiveSet.create('/path/to/set.als')
 * console.log(liveSet.info)
 *
 * // Load an entire Ableton project directory
 * const project = await new LiveProject('/path/to/My Song Project')
 * await project.loadSets()
 * console.log(project.liveSets[0].info)
 */

// import { LiveSet, LiveProject } from './lib/LiveSet.js'

export { LiveSet, LiveProject } from './lib/LiveSet.js'
