/* global posenet, requestAnimationFrame */

import { loadVideo, preferredVideoSize } from './camera-util.js'
import { playNote, getMidiDevices, getAnalyzerValue } from './audio-controller.js'
import { drawKeypoints, drawSkeleton, drawBox, drawWave, drawScale } from './canvas-overlay.js'
import { guiState, setupGui } from './control-panel.js'
import { chords } from './chord-intervals.js'

const isMobile = function () {
  const isAndroid = /Android/i.test(navigator.userAgent)
  const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)

  return isAndroid || isiOS
}

let VIDEOWIDTH = 800
let VIDEOHEIGHT = 600

const ZONEOFFSET = 10
const ZONEFACTOR = isMobile() ? 0.5 : 0.7
let ZONEWIDTH = VIDEOWIDTH * 0.5
let ZONEHEIGHT = VIDEOHEIGHT * ZONEFACTOR

const LEFTWRIST = 9
const RIGHTWRIST = 10

let posenetModel = null

const setUserMedia = function () {
  navigator.getUserMedia = navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia
}

const resetVideoCanvasSize = function (video, canvas) {
  const size = preferredVideoSize(video, isMobile())

  VIDEOWIDTH = size.width
  VIDEOHEIGHT = size.height
  ZONEWIDTH = VIDEOWIDTH * 0.5
  ZONEHEIGHT = VIDEOHEIGHT * ZONEFACTOR

  if (canvas) {
    canvas.setAttribute('width', VIDEOWIDTH)
    canvas.setAttribute('height', VIDEOHEIGHT)
    video.setAttribute('width', VIDEOWIDTH)
    video.setAttribute('height', VIDEOHEIGHT)
  }
}

const resize = function () {
  const canvas = document.getElementById('output')
  const video = document.getElementById('video')
  resetVideoCanvasSize(video, canvas)
}

/**
 * Feeds an image to posenet to estimate poses - this is where the magic happens.
 * This function loops with a requestAnimationFrame method.
 */
const detectPoseInRealTime = function (video) {
  const canvas = document.getElementById('output')
  const canvasCtx = canvas.getContext('2d')
  const flipHorizontal = true // since images are being fed from a webcam
  const waveCtx = document.getElementById('wave').getContext('2d')

  resetVideoCanvasSize(video)
  canvas.width = VIDEOWIDTH
  canvas.height = VIDEOHEIGHT

  async function poseDetectionFrame () {
    if (guiState.changeToArchitecture) {
      // Important to purge variables and free up GPU memory
      posenetModel.dispose()

      // Load the PoseNet model weights for either the 0.50, 0.75, 1.00, or 1.01 version
      posenetModel = await posenet.load(+guiState.changeToArchitecture)

      guiState.changeToArchitecture = null
    }

    // Scale an image down to a certain factor.
    // Too large of an image will slow down the GPU
    const imageScaleFactor = guiState.input.imageScaleFactor
    const outputStride = +guiState.input.outputStride

    let poses = []
    let minPoseConfidence
    let minPartConfidence

    switch (guiState.algorithm) {
      case 'single-pose':
        const pose = await posenetModel.estimateSinglePose(
          video,
          imageScaleFactor,
          flipHorizontal,
          outputStride
        )
        poses.push(pose)

        minPoseConfidence = +guiState.singlePoseDetection.minPoseConfidence
        minPartConfidence = +guiState.singlePoseDetection.minPartConfidence
        break
      case 'multi-pose':
        poses = await posenetModel.estimateMultiplePoses(
          video,
          imageScaleFactor,
          flipHorizontal,
          outputStride,
          guiState.multiPoseDetection.maxPoseDetections,
          guiState.multiPoseDetection.minPartConfidence,
          guiState.multiPoseDetection.nmsRadius
        )

        minPoseConfidence = +guiState.multiPoseDetection.minPoseConfidence
        minPartConfidence = +guiState.multiPoseDetection.minPartConfidence
        break
    }

    canvasCtx.clearRect(0, 0, VIDEOWIDTH, VIDEOHEIGHT)

    const topOffset = ZONEHEIGHT - (ZONEHEIGHT * guiState.notesRangeScale) + ZONEOFFSET
    const notesOffset = (ZONEHEIGHT - topOffset) * guiState.notesRangeOffset

    const chordsInterval = guiState.chordIntervals === 'default' ? null : guiState.chordIntervals
    let chordsArray = []
    if (chordsInterval && chordsInterval !== 'default' && chords.hasOwnProperty(chordsInterval)) {
      chordsArray = chords[chordsInterval]
    }

    if (guiState.canvas.showVideo) {
      canvasCtx.save()
      canvasCtx.scale(-1, 1)
      canvasCtx.translate(-VIDEOWIDTH, 0)
      canvasCtx.drawImage(video, 0, 0, VIDEOWIDTH, VIDEOHEIGHT)
      canvasCtx.restore()
    }

    if (guiState.canvas.showZones) {
      // draw left zone
      drawBox(ZONEOFFSET, ZONEOFFSET, ZONEWIDTH, ZONEHEIGHT, canvasCtx)
      // draw right zone
      drawBox(ZONEWIDTH, ZONEOFFSET, VIDEOWIDTH - ZONEOFFSET, ZONEHEIGHT, canvasCtx)
      // draw notes range scale
      drawScale(
        (VIDEOWIDTH - ZONEOFFSET),
        (topOffset + notesOffset),
        (VIDEOWIDTH - ZONEOFFSET),
        (ZONEHEIGHT + notesOffset),
        (chordsArray.length || 100),
        canvasCtx,
        [ZONEOFFSET, ZONEHEIGHT])
    }

    // For each pose (i.e. person) detected in an image, loop through the poses and
    // draw the resulting skeleton and keypoints if over certain confidence scores
    // and send data to play corresponding note
    poses.forEach(({ score, keypoints }) => {
      if (score >= minPoseConfidence) {
        const leftWrist = keypoints[LEFTWRIST]
        const rightWrist = keypoints[RIGHTWRIST]

        if (leftWrist.score > minPartConfidence && rightWrist.score > minPartConfidence) {
          // Normalize keypoints to values between 0 and 1 (horizontally & vertically)
          const position = normalizePositions(leftWrist, rightWrist, (topOffset + notesOffset), (ZONEHEIGHT + notesOffset))

          if (position.right.vertical > 0 && position.left.horizontal > 0) {
            playNote(
              position.right.vertical, // note
              position.left.horizontal, // volume
              guiState.noteDuration,
              chordsArray
            )
          } else {
            playNote(0, 0)
          }
        } else {
          playNote(0, 0)
        }

        if (guiState.canvas.showPoints) {
          drawKeypoints(keypoints, minPartConfidence, canvasCtx)
        }
        if (guiState.canvas.showSkeleton) {
          drawSkeleton(keypoints, minPartConfidence, canvasCtx)
        }
      }
    })

    if (guiState.canvas.showWaveform) {
      const value = getAnalyzerValue()
      drawWave(value, waveCtx)
    }

    requestAnimationFrame(poseDetectionFrame)
  }

  poseDetectionFrame()
}

/**
 * Returns an object the horizontal and vertical positions of left and right wrist normalized between 0 and 1
 *
 * @param {Object} leftWrist - posenet 'leftWrist' keypoints (corresponds to user's right hand)
 * @param {Object} rightWrist - posenet 'rightWrist' keypoints (corresponds to user's left hand)
 * @param {Number} notesTopOffset - top edge (max position) for computing vertical notes
 */
const normalizePositions = function (leftWrist, rightWrist, topOffset = ZONEOFFSET, bottomOffset = ZONEHEIGHT) {
  const leftZone = rightWrist.position
  const rightZone = leftWrist.position

  const leftEdge = ZONEOFFSET
  const verticalSplit = ZONEWIDTH
  const rightEdge = VIDEOWIDTH - ZONEOFFSET
  const topEdge = topOffset
  const bottomEdge = bottomOffset

  let position = {
    right: {
      vertical: 0,
      horizontal: 0
    },
    left: {
      vertical: 0,
      horizontal: 0
    }
  }

  if (rightZone.x >= verticalSplit && rightZone.x <= rightEdge) {
    position.right.horizontal = computePercentage(rightZone.x, verticalSplit, rightEdge)
  }
  if (rightZone.y <= ZONEHEIGHT && rightZone.y >= ZONEOFFSET) {
    position.right.vertical = computePercentage(rightZone.y, bottomEdge, topEdge)
  }
  if (leftZone.x >= leftEdge && leftZone.x <= verticalSplit) {
    position.left.horizontal = computePercentage(leftZone.x, verticalSplit, leftEdge)
  }
  if (leftZone.y <= ZONEHEIGHT && leftZone.y >= ZONEOFFSET) {
    position.left.vertical = computePercentage(leftZone.y, ZONEHEIGHT, ZONEOFFSET)
  }

  return position
}

/**
 * Compute percentage of the provided value in the given range
 *
 * @param {Number} value - a number between 'low' and 'high' to compute percentage
 * @param {Number} low - corresponds to a number that should produce value 0
 * @param {Number} high - corresponds to a number that should produce value 1
 */
const computePercentage = function (value, low, high) {
  const dist = isNaN(value) ? 0 : value
  const minDist = isNaN(low) ? 0 : low
  const maxDist = isNaN(high) ? dist + 1 : high

  return (dist - minDist) / (maxDist - minDist)
}

/**
 * Kicks off the demo by loading the posenet model, finding and loading
 * available camera devices, and setting off the detectPoseInRealTime function.
 */
const bindPage = async function () {
  posenetModel = await posenet.load(0.75) // load the PoseNet with architecture 0.75

  const body = document.getElementsByTagName('body')[0]

  const mobile = isMobile()
  let video

  try {
    video = await loadVideo('video', mobile)
    await setupGui([], mobile)
    body.className = 'ready'
    detectPoseInRealTime(video)
  } catch (e) {
    body.className = 'error'
    const info = document.getElementById('info')
    info.textContent = 'Browser does not support video capture or this device does not have a camera'
    throw e
  }

  window.onresize = resize
}

// init the app
const init = function () {
  const waveCtx = document.getElementById('wave').getContext('2d')
  drawWave([], waveCtx)

  setUserMedia()
  getMidiDevices().then(bindPage)
}

// run the app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  setTimeout(init, 500)
}
