const youtubedl = require('youtube-dl');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const request = require('request-promise');
const requestNoPromise = require('request');
const _ = require('lodash');
const acoustid = require('acoustid');
const EyeD3 = require('eyed3');
const eyed3 = new EyeD3({ eyed3_executable: 'eyeD3' });
const levenshtein = require('fast-levenshtein');
const crypto = require('crypto');

// API keys
const API_ECHONEST_KEY = 'BPDC3NESDOHXKDIBZ';
const API_ACOUSTID = 'lm59lNN597';

var at3 = {};

/**
 * Download a single video with youtube-dl
 * @param url
 * @param outputFile
 */
at3.downloadWithYoutubeDl = function(url, outputFile) {
    var download = youtubedl(url, ['-f', 'bestaudio']);
    const downloadEmitter = new EventEmitter();

    var size = 0;
    download.on('info', function(info) {
        size = info.size;

        downloadEmitter.emit('download-start', {
            size: size
        });

        download.pipe(fs.createWriteStream(outputFile));
    });

    var pos = 0;
    download.on('data', function data(chunk) {
        pos += chunk.length;

        if (size) {
            var percent = (pos / size * 100).toFixed(2);

            downloadEmitter.emit('download-progress', {
                downloaded: pos,
                progress: percent
            });
        }
    });

    download.on('end', function end() {
        downloadEmitter.emit('download-end');
    });

    return downloadEmitter;
};

/**
 * Convert a outputFile in MP3
 * @param inputFile
 * @param outputFile
 * @param bitrate string
 */
at3.convertInMP3 = function(inputFile, outputFile, bitrate) {
    const convertEmitter = new EventEmitter();

    var convert = ffmpeg(inputFile)
        .audioBitrate(bitrate)
        .audioCodec('libmp3lame')
        .on('codecData', function(data) {
            convertEmitter.emit('convert-start');
        })
        .on('progress', function(progress) {
            convertEmitter.emit('convert-progress', {
                progress: progress.percent
            });
        })
        .on('end', function() {
            fs.unlink(inputFile);
            convertEmitter.emit('convert-end');
        })
        .save(outputFile);

    return convertEmitter;
};

/**
 * Get infos about an online video with youtube-dl
 * @param url
 */
at3.getInfosWithYoutubeDl = function(url) {
    return new Promise(function (resolve, reject) {
        youtubedl.getInfo(url, function (err, infos) {
            resolve({
                title: infos.title,
                author: infos.uploader,
                picture: infos.thumbnail
            });
        });
    });
};

/**
 * Download a single URL in MP3
 * @param url
 * @param outputFile
 * @param bitrate
 */
at3.downloadSingleURL = function(url, outputFile, bitrate) {
    const progressEmitter = new EventEmitter();
    var tempFile = outputFile + '.video';

    var dl = at3.downloadWithYoutubeDl(url, tempFile);

    dl.on('download-start', function() {
        progressEmitter.emit('start');
    });
    dl.on('download-progress', function(infos) {
        progressEmitter.emit('download', {
            progress: infos.progress
        });
    });

    dl.on('download-end', function() {
        progressEmitter.emit('download-end');

        var convert = at3.convertInMP3(tempFile, outputFile, bitrate);

        convert.on('convert-progress', function(infos) {
            progressEmitter.emit('convert', {
                progress: infos.progress
            });
        });
        convert.on('convert-end', function() {
            progressEmitter.emit('end');
        });
    });

    return progressEmitter;
};

/**
 * Try to find to title and artist from a string
 * (example: a YouTube video title)
 * @param query string
 * @param exact boolean Can the query be modified or not
 * @param last boolean Last call
 * @param v boolean Verbose
 */
at3.guessTrackFromString = function(query, exact, last, v) {
    if (exact === undefined) {
        exact = false;
    }
    if (last === undefined) {
        last = false;
    }
    if (v === undefined) {
        v = false;
    }

    if (v) {
        console.log("Query: ", query);
    }

    var searchq = query;
    if (!exact) {
        searchq = searchq.replace(/\(.*\)/g, '');
		searchq = searchq.replace(/\[.*\]/g, '');
		searchq = searchq.replace(/lyric(s?)|parole(s?)/ig, '');
    }

    var requests = [];
    var infos = {
        title: null,
        artistName: null,
    };

    // We search on Echonest, Deezer and iTunes
    // Echonest
    var requestEchonest = request({
        url: 'http://developer.echonest.com/api/v4/song/search?api_key=' + API_ECHONEST_KEY + '&format=json&results=10&bucket=id:7digital-US&bucket=audio_summary&bucket=tracks&combined=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.response.songs, function (s) {
			if (!title) {
				if (vsimpleName(searchq, exact).match(new RegExp(vsimpleName(s.artist_name), 'ig'))) {
					if (delArtist(s.artist_name, searchq, exact).match(new RegExp(vsimpleName(s.title), 'ig'))) {
						artistName = s.artist_name;
						title = s.title;
					} else if (!artistName) {
						artistName = s.artist_name;
						tempTitle = s.title;
					}
				}
			}
		});
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("Echonest answer: ", title, '-', artistName);
        }
    });

    // Deezer
    var requestDeezer = request({
        url: 'http://api.deezer.com/2.0/search?q=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.data, function (s) {
			if (!title) {
				if (vsimpleName(searchq,exact).replace(new RegExp(vsimpleName(s.artist.name), 'ig'))) {
					if (delArtist(s.artist.name, searchq, exact).match(new RegExp(vsimpleName(s.title), 'ig')) || vsimpleName(s.title).match(new RegExp(delArtist(s.artist.name, searchq, exact), 'ig'))) {
						artistName = s.artist.name;
						title = s.title;
					} else if(!artistName) {
						artistName = s.artist.name;
						tempTitle = s.title;
					}
				}
			}
		});
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("Deezer answer: ", title, '-', artistName);
        }
    });

    // iTunes
    var requestiTunes = request({
        url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(searchq),
        json: true
    }).then(function (body) {
        var title, artistName, tempTitle;
        _.forEach(body.results, function (s) {
			if (!title) {
				if (vsimpleName(searchq, exact).match(new RegExp(vsimpleName(s.artistName), 'gi'))) {
					if (delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackName), 'gi'))) {
						artistName = s.artistName;
						title = s.trackName;
					} else if(delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackCensoredName), 'gi'))) {
						artistName = s.artistName;
						title = s.trackCensoredName;
					} else if(!artistName) {
						artistName = s.artistName;
						temp_title = s.trackName;
					}
				}
			}
		});
        if (title && artistName) {
            infos.title = title;
            infos.artistName = artistName;
        }
        if (v) {
            console.log("iTunes answer: ", title, '-', artistName);
        }
    });

    requests.push(requestEchonest);
    requests.push(requestDeezer);
    requests.push(requestiTunes);

    return Promise.all(requests).then(function() {
        if (!last && (!infos.title || !infos.artistName)) {
            searchq = searchq.replace(/f(ea)?t(\.)? [^-]+/ig,' ');
			return at3.guessTrackFromString(searchq, false, true, v);
        }
        return infos;
    });

};

/**
 * Try to guess title and artist from mp3 file
 * @param file
 */
at3.guessTrackFromFile = function (file) {
    return new Promise(function (resolve, reject) {
        acoustid(file, { key: API_ACOUSTID }, function (err, results) {
            if (err || results.length === 0) {
                reject();
                return;
            }
            resolve({
                title: results[0].recordings[0].title,
                artistName: results[0].recordings[0].artists[0].name
            });
        });
    });
};


/**
 * Retrieve informations about a track from artist and title
 * @param title
 * @param artistName
 * @param exact boolean Exact search or not
 * @param v boolean Verbose
 */
at3.retrieveTrackInformations = function (title, artistName, exact, v) {
    if (exact === undefined) {
        exact = false;
    }
    if (v === undefined) {
        v = false;
    }

    if (!exact) {
	    title = title.replace(/((\[)|(\())?radio edit((\])|(\)))?/ig, '');
	}

    var infos = {
        title: title,
        artistName: artistName
    };

    var requests = [];

    var requestDeezer = request({
        url: 'http://api.deezer.com/2.0/search?q=' + encodeURIComponent(artistName + ' ' + title),
        json: true
    }).then(function (body) {
        var deezerInfos;
        _.forEach(body.data, function (s) {
        	if(!infos.deezerId && imatch(vsimpleName(title), vsimpleName(s.title)) && imatch(vsimpleName(artistName), vsimpleName(s.artist.name))) {
        		infos.deezerId = s.id;
                deezerInfos = _.clone(s);
        	}
        });
        if (infos.deezerId) {
            infos.artistName = deezerInfos.artist.name;
            infos.title = deezerInfos.title;

            return request({
                url: 'http://api.deezer.com/2.0/track/' + infos.deezerId,
                json: true
            }).then(function (trackInfos) {
                infos.position = trackInfos.track_position;
                infos.duration = trackInfos.duration;
                infos.deezerAlbum = trackInfos.album.id;
                infos.discNumber = trackInfos.disk_number;

                return request({
                    url: 'http://api.deezer.com/2.0/album/' + infos.deezerAlbum,
                    json: true
                });
            }).then(function (albumInfos) {
                infos.album = albumInfos.title;
                infos.releaseDate = albumInfos.release_date;
                infos.nbTracks = albumInfos.tracks.data.length;
                infos.genreId = albumInfos.genre_id;

                return request({
                    url: albumInfos.cover + '?size=big',
                    method: "HEAD",
                    resolveWithFullResponse: true
                });
            }).then(function (responseCover) {
                infos.cover = responseCover.request.uri.href.replace('400x400', '600x600');

                return request({
                    url: 'http://api.deezer.com/2.0/genre/' + infos.genreId,
                    json: true
                });
            }).then(function (genreInfos) {
                infos.genre = genreInfos.name;

                if (v) {
                    console.log("Deezer infos: ", infos);
                }
            });
        }
    });

    var requestiTunes = request({
        url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(artistName + ' ' + title),
        json: true
    }).then(function (body) {
        var itunesInfos;
        _.forEach(body.results, function (s) {
			if (!infos.itunesId && (imatch(vsimpleName(title), vsimpleName(s.trackName)) || imatch(vsimpleName(title), vsimpleName(s.trackCensoredName))) && imatch(vsimpleName(artistName), vsimpleName(s.artistName))) {
				infos.itunesId = s.trackId;
				itunesInfos = _.clone(s);
			}
		});
        if (!infos.deezerId && itunesInfos) {
            infos.artistName = itunesInfos.artistName;
            if (imatch(vsimpleName(infos.title), vsimpleName(itunesInfos.trackName))) {
                infos.title = itunesInfos.trackName;
            } else {
                infos.title = itunesInfos.trackCensoredName;
            }
            infos.itunesAlbum = itunesInfos.collectionId;
            infos.position = itunesInfos.trackNumber;
            infos.nbTracks = itunesInfos.trackCount;
            infos.album = itunesInfos.collectionName;
            infos.releaseDate = itunesInfos.releaseDate.replace(/T.+/, '');
            infos.cover = itunesInfos.artworkUrl100.replace('100x100', '200x200');
            infos.genre = itunesInfos.primaryGenreName;
            infos.discNumber = itunesInfos.discNumber;
        }

        if (v) {
            console.log("iTunes infos: ", itunesInfos);
        }
    });

    requests.push(requestDeezer);
    requests.push(requestiTunes);

    return Promise.all(requests).then(function () {
        return infos;
    });
};

/**
 * Add tags to MP3 file
 * @param file
 * @param infos
 */
at3.tagFile = function (file, infos) {
    var meta = {
        title: infos.title,
        artist: infos.artistName
    };
    if (infos.album) {
        meta.album = infos.album;
    }
    if (infos.position) {
        meta.track = infos.position;
    }
    if (infos.nbTracks) {
        meta.trackTotal = infos.nbTracks;
    }
    if (infos.discNumber) {
        meta.disc = infos.disc;
    }
    if (infos.releaseDate) {
        meta.year = (/[0-9]{4}/.exec(infos.releaseDate))[0];
    }
    if (infos.genre) {
        meta.genre = infos.genre.replace(/\/.+$/g, '');
    }

    var updateInfos = new Promise(function (resolve, reject) {
        eyed3.updateMeta(file, meta, function (err) {
            if (err) {
                console.log(err);
            }
            resolve();
        });
    });

    var updateCover = new Promise(function (resolve, reject) {
        if (infos.cover) {
            var coverPath = file + '.cover.jpg';

            requestNoPromise(infos.cover, function () {
                eyed3.updateMeta(file, {image: coverPath}, function (err) {
                    if (err) {
                        console.log("image error: ", err);
                    }
                    fs.unlinkSync(coverPath);

                    resolve();
                });
            }).pipe(fs.createWriteStream(coverPath));
        } else {
            resolve();
        }
    });

    return Promise.all([updateInfos, updateCover]);
};

/**
 * Download and convert a single URL,
 * retrieve and add tags to the MP3 file
 * @param url
 * @param v boolean Verbosity
 */
at3.downloadAndTagSingleURL = function (url, v) {
    if (v === undefined) {
        v = false;
    }

    var tempFile = crypto.createHash('sha256').update(url).digest('hex') + '.mp3';

    // Download and convert file
    var dl = at3.downloadSingleURL(url, tempFile, '320k');

    var infosFromString, infosFromFile, videoTitle;

    // Try to find information based on video title
    var getStringInfos = at3.getInfosWithYoutubeDl(url).then(function(videoInfos) {
        infosFromString = {
            title: videoInfos.title,
            artistName: videoInfos.author,
            cover: videoInfos.picture // [TODO] Create square image
        };

        videoTitle = videoInfos.title;

        if (v) {
            console.log("Video infos: ", infosFromString);
        }

        // [TODO] Emit event with these infos

        return at3.guessTrackFromString(videoInfos.title, false, false, v);
    }).then(function (guessStringInfos) {
        if (guessStringInfos.title && guessStringInfos.artistName) {
            return at3.retrieveTrackInformations(guessStringInfos.title, guessStringInfos.artistName, false, v);
        } else {
            return Promise.resolve();
        }
    }).then(function (guessStringInfos) {
        // [TODO] Emit event with these infos
        if (guessStringInfos) {
            infosFromString = guessStringInfos;
            if (v) {
                console.log("guessStringInfos: ", guessStringInfos);
            }
        } else {
            if (v) {
                console.log('Cannot retrieve detailed information from video title');
            }
        }
    });

    // Try to find information based on MP3 file when dl is finished
    dl.once('end', function() {
        var getFileInfos = at3.guessTrackFromFile(tempFile).then(function (guessFileInfos) {
            if (guessFileInfos.title && guessFileInfos.artistName) {
                return at3.retrieveTrackInformations(guessFileInfos.title, guessFileInfos.artistName, false, v);
            } else {
                return Promise.resolve();
            }
        }).then(function (guessFileInfos) {
            if (guessFileInfos) {
                infosFromFile = guessFileInfos;
                if (v) {
                    console.log("guessFileInfos: ", guessFileInfos);
                }
            } else {
                if (v) {
                    console.log('Cannot retrieve detailed information from MP3 file');
                }
            }
        });

        // [TODO] Improve network issue resistance
        Promise.all([getStringInfos, getFileInfos]).then(function() {
            var infos = infosFromString;
            if (infosFromFile) {
                var scoreFromFile = Math.min(
                    levenshtein.get(simpleName(infosFromFile.title + ' ' + infosFromFile.artistName), simpleName(videoTitle)),
                    levenshtein.get(simpleName(infosFromFile.artistName + ' ' + infosFromFile.title), simpleName(videoTitle))
                );
                var scoreFromString = Math.min(
                    levenshtein.get(simpleName(infosFromString.title + ' ' + infosFromString.artistName), simpleName(videoTitle)),
                    levenshtein.get(simpleName(infosFromString.artistName + ' ' + infosFromString.title), simpleName(videoTitle))
                );

                if (v) {
                    console.log("Infos from file score: ", scoreFromFile);
                    console.log("Infos from string score: ", scoreFromString);
                }

                if (scoreFromFile < (scoreFromString + Math.ceil(simpleName(videoTitle).length/10.0))) {
                    infos = infosFromFile;
                }
            }

            if (v) {
                console.log('Final infos: ', infos);
            }

            at3.tagFile(tempFile, infos).then(function() {
                fs.rename(tempFile, infos.artistName + ' - ' + infos.title + '.mp3');
            });
        });
    });
};

function imatch(textSearched, text) {
    // [TODO] Improve this function (use .test and espace special caracters + use it everywhere else)
    return text.match(new RegExp(textSearched, 'gi'));
}
function vsimpleName(text, exact) {
    if (exact === undefined) {
        exact = false;
    }
    text = text.toLowerCase();
    if (!exact) {
        // text = text.replace('feat', '');
    }
    text = text.replace(/((\[)|(\())?radio edit((\])|(\)))?/ig, '');
    text = text.replace(/[^a-zA-Z0-9]/ig, '');
    return text;
}
function delArtist(artist, text, exact) {
    if (exact === undefined) {
        exact = false;
    }
    if(vsimpleName(artist).length <= 2) { // Artist with a very short name (Mathieu Chedid - M)
        return vsimpleName(text, exact);
    } else {
        // [TODO] Improve, escape regex special caracters in vsimpleName(artist)
        return vsimpleName(text, exact).replace(new RegExp(vsimpleName(artist),'ig'), '');
    }
}
function simpleName(text) {
    return text.replace(/\(.+\)/g, '');
}

module.exports = at3;