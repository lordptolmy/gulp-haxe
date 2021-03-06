'use strict'
const manifest = require(process.cwd()+'/package.json')
const nodeBin = require('./src/nodeBin')
const switchx = nodeBin('switchx/bin/switchx.js')
const haxeshim = nodeBin('haxeshim/bin/haxeshim.js')
const gutil = require('gulp-util')
const fs = require('fs')
const path = require('path')
const async = require('async')
const Readable = require('stream').Readable
const osTmpdir = require('os-tmpdir')
const md5Hex = require('md5-hex')
const glob = require('glob')
const convert = require('convert-source-map')
const apply = require('vinyl-sourcemaps-apply')
const lib = require('./src/lib')
const haxeError = require('./src/error')

const TARGETS = ['js', 'as3', 'swf', 'neko', 'php', 'cpp', 'cs', 'java', 'python', 'lua', 'hl']
const libCache = {}
const completionServers = {}
let haxeVersionCheck

function combine(a, b) {
	Object.keys(b).forEach(key => {
		if (key in a)
			a[key] = [].concat(a[key], b[key])
		else
			a[key] = b[key]
	})
	return a
}

function readHxml(source, cb) {
	if (typeof source != 'string') {
		if (Array.isArray(source)) return cb(source)
		return cb([source])
	}
	fs.readFile(source, function(err, data) {
		const response = []

		let current = {}
		let each = {}

		data.toString()
		.split('\n')
		.map(Function.prototype.call, String.prototype.trim)
		.filter(_ => _ != '' && _.substr(0, 1) != '#')
		.forEach(function (command) {
			const parts = command.split(' ')
			const cmd = parts.shift()
			if (cmd.substr(0, 1) != '-')
				throw 'To be implemented'
			let key = cmd.substr(1)
			const value = parts.join(' ')

			switch (key) {
				case '-each':
					each = current
					current = {}
					break
				case '-next':
					response.push(combine(current, each))
					current = {}
					break
				default:
					if (key.substr(0, 1) == '-') {
						key = key.substr(1)
						value = true
					}
					const obj = {}
					obj[key] = value
					combine(current, obj)
			}
		})

		response.push(combine(current, each))
		cb(response)
	})
}

function toArgs(hxml) {
	const response = []
	Object.keys(hxml)
	.map(key => {
		const value = hxml[key]
		const cmd = '-'+key
		if (Array.isArray(value)) {
			value.forEach(_ => {
				response.push(cmd)
				response.push(''+_)
			})
		} else if (typeof(value) === 'boolean') {
			if (value) 
				response.push(cmd)
		} else {
			response.push(cmd)
			if(value) 
				response.push(''+value)
		}
	})

	return response
}

function addFile(file, location, done, sourceMaps) {
	fs.readFile(file, function (err, data) {
		if (err) return done(err)
		const filePath = path.join(location.original, path.relative(location.output, file))
		const vinylFile = new gutil.File({
			cwd: process.cwd(),
			base: '.',
			path: filePath
		})

		if (sourceMaps) {
			let fileString = data.toString('utf-8')
			const map = convert.fromMapFileSource(fileString, path.dirname(location.output))
			if (map != null) {
				fileString = convert.removeMapFileComments(fileString)
				fileString += map.toComment()
				data = new Buffer(fileString)
				apply(vinylFile, map.toJSON())
			}
		}

		vinylFile.contents = data

		done(null, vinylFile)
	})
}

function addFiles(stream, files, location, done, sourceMaps) {
	async.each(files, function (path, next) {
		fs.stat(path, (err, stats) => {
			if (err) return next(err)
			if (stats.isDirectory()) return next()
			addFile(path, location, (err, file) => {
				if (err) return next(err)
				stream.push(file)
				next()
			}, sourceMaps)
		})
	}, done)
}

function installLib(name, next) {
	if (name in libCache)
		return libCache[name].then(next)
	const current = lib(name)
	libCache[name] = 
	current.version()
	.then(version => {
		if (version == null) {
			gutil.log('Installing '+name)
			return current.install().then(_ => current.version())
		}
		return version
	})
	.then(
		version => {
			const parts = name.split(':')
			gutil.log('Using '+parts[0]+' '+(parts[1]?parts[1]:version))
		}, 
		err => {
			gutil.log(gutil.colors.red('Could not install '+name))
			gutil.log(err)
		}
	)
	.then(next)
}

function compile(stream, hxml, options, next) {
	const target = Object.keys(hxml).filter(_ => TARGETS.indexOf(_) > -1)[0]
	if (!target) {
		console.log(hxml)
		throw 'No target set'
	}

	function run() {
		const temp = path.join(osTmpdir(), 'gulp-haxe')
		const location = {
			original: hxml[target],
			output: path.join(temp, md5Hex(process.cwd() + toArgs(hxml)))
		}
		hxml[target] = location.output
		if (options.completion && (options.completion in completionServers)) {
			hxml['-connect'] = ''+options.completion
		}

		const args = toArgs(hxml)
		const haxe = haxeshim(args)

		haxe.stdout.on('data', data => 
			data.toString().split('\n').forEach(line => gutil.log(line))
		)
		haxe.stderr.on('data', haxeError.bind(null, target))

		haxe.on('close', function (code) {
			if (code != 0) return next('Exited with error code: ' + code)

			fs.stat(location.output, (err, stats) => {
				if (err) return next(err)
				const files = []
				const sourceMaps = 'debug' in hxml && hxml.debug && target == 'js'
				if (stats.isDirectory())
					glob(path.join(location.output, '**', '*'), (err, files) => {
						if (err) return next(err)
						addFiles(stream, files, location, next, sourceMaps)
					})
				else
					addFiles(stream, [location.output], location, next, sourceMaps)
			})
		})
	}

	if ('lib' in hxml) {
		async.each(
			[].concat(hxml.lib),
			installLib, 
			err => {
				if (err) console.log(err)
				else run()
			}
		)
	} else {
		run()
	}
}

function startCompletion(port, verbose) {
	const args = ['--wait', ''+port]
	if (verbose) args.unshift('-v')
	const server = haxeshim(args)
	server.stdout.pipe(process.stdout)
	server.stderr.pipe(process.stderr)
	server.on('close', code => {
		delete completionServers[port]
	})
}

module.exports = (source, options) => {
	const stream = new Readable({objectMode: true})
	stream._read = function () {}
	if (!options) options = {}

	function start() {
		if (options.completion && !(options.completion in completionServers)) {
			startCompletion(options.completion, false)
			completionServers[options.completion] = true
		}

		readHxml(source, all => {
			async.each(
				all,
				(hxml, next) => compile(stream, hxml, options, next), 
				err => {
					if(!err) {
						stream.push(null)
						return
					}

					console.log(err)

					if(!options.exitOnError) return
					stream.destroy(new Error(err))
				}
			)
		})
	}

	if (haxeVersionCheck == null)
		haxeVersionCheck = new Promise(function(success, _) {
			let version = 'latest'
			if ('haxe' in manifest && 'version' in manifest.haxe)
				version = manifest.haxe.version

			fs.writeFileSync('.haxerc', JSON.stringify({
				version: version,
				resolveLibs: 'haxelib'
			}))

			gutil.log('Using haxe '+version)
			const installation = switchx(['install'])
			installation.stderr.on('data', data => gutil.log(data.toString()))
			installation.on('exit', () => success())
		})

	haxeVersionCheck.then(start)

	return stream
}

module.exports.readHxml = readHxml