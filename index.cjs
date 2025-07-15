const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const { differenceInSeconds, parse } = require("date-fns");

const temp = (name) => path.join(__dirname, "output", name);

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

async function normalizeAudioFormat(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioFrequency(44100)
      .audioChannels(2)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function createSilence(duration, outPath) {
  return new Promise((resolve, reject) => {
    console.log(`🔇 Creating ${duration}s of silence at ${outPath}`);

    // Method 1: Try anullsrc with libmp3lame
    ffmpeg()
      .input(`anullsrc=channel_layout=stereo:sample_rate=44100`)
      .inputFormat("lavfi")
      .duration(duration)
      .audioCodec("libmp3lame")
      .audioBitrate(128)
      .output(outPath)
      .on("end", () => {
        console.log(`✅ Silence created successfully: ${duration}s`);
        resolve();
      })
      .on("error", (err) => {
        console.log(
          "❌ anullsrc with libmp3lame failed, trying with copy from existing audio..."
        );

        // Method 2: Create silence by using an existing audio file as template
        createSilenceFromTemplate(duration, outPath)
          .then(() => {
            console.log(`✅ Silence created from template: ${duration}s`);
            resolve();
          })
          .catch((err2) => {
            console.log("❌ Template method failed, trying WAV creation...");

            // Method 3: Create as WAV (most compatible)
            const wavPath = outPath.replace(".mp3", ".wav");

            ffmpeg()
              .input(`anullsrc=channel_layout=stereo:sample_rate=44100`)
              .inputFormat("lavfi")
              .duration(duration)
              .audioCodec("pcm_s16le")
              .output(wavPath)
              .on("end", () => {
                // Convert WAV to MP3 using the same codec as input files
                convertWavToMp3(wavPath, outPath)
                  .then(() => {
                    // Clean up WAV file
                    if (fs.existsSync(wavPath)) {
                      fs.unlinkSync(wavPath);
                    }
                    console.log(
                      `✅ Silence created via WAV conversion: ${duration}s`
                    );
                    resolve();
                  })
                  .catch(reject);
              })
              .on("error", (err3) => {
                console.log(
                  "❌ WAV creation failed, trying manual PCM creation..."
                );
                createSilenceManually(duration, outPath)
                  .then(() => {
                    console.log(`✅ Silence created manually: ${duration}s`);
                    resolve();
                  })
                  .catch(reject);
              })
              .run();
          });
      })
      .run();
  });
}

// Create silence by copying and muting an existing audio file
async function createSilenceFromTemplate(duration, outPath) {
  return new Promise((resolve, reject) => {
    // Use one of the input files as a template
    const templateFile = path.join(__dirname, "input", "ps.mp3");

    if (!fs.existsSync(templateFile)) {
      reject(new Error("Template file not found"));
      return;
    }

    ffmpeg(templateFile)
      .audioFilters("volume=0") // Mute the audio
      .duration(duration)
      .output(outPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// Convert WAV to MP3 using available codecs
async function convertWavToMp3(wavPath, mp3Path) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(wavPath);

    // Try different MP3 codecs in order of preference
    const codecs = ["libmp3lame", "mp3", "mp3_mf"];

    function tryCodec(codecIndex) {
      if (codecIndex >= codecs.length) {
        reject(new Error("No MP3 codec available"));
        return;
      }

      const codec = codecs[codecIndex];

      ffmpeg(wavPath)
        .audioCodec(codec)
        .audioBitrate(128)
        .output(mp3Path)
        .on("end", resolve)
        .on("error", () => {
          console.log(`❌ Codec ${codec} failed, trying next...`);
          tryCodec(codecIndex + 1);
        })
        .run();
    }

    tryCodec(0);
  });
}

// Fallback function to create silence manually as WAV
async function createSilenceManually(duration, outPath) {
  return new Promise((resolve, reject) => {
    // Calculate the number of samples needed
    const sampleRate = 44100;
    const channels = 2;
    const samplesPerChannel = Math.floor(duration * sampleRate);
    const totalSamples = samplesPerChannel * channels;

    // Create a buffer of zeros (silence)
    const buffer = Buffer.alloc(totalSamples * 2); // 2 bytes per sample for 16-bit
    buffer.fill(0);

    // Write WAV header and data
    const wavHeader = createWavHeader(samplesPerChannel, sampleRate, channels);
    const wavData = Buffer.concat([wavHeader, buffer]);

    // Create as WAV first
    const tempWavPath = outPath.replace(".mp3", "_temp.wav");

    fs.writeFile(tempWavPath, wavData, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Try to convert to MP3, but if it fails, just use WAV
      convertWavToMp3(tempWavPath, outPath)
        .then(() => {
          // Clean up temp WAV file
          if (fs.existsSync(tempWavPath)) {
            fs.unlinkSync(tempWavPath);
          }
          resolve();
        })
        .catch(() => {
          // If MP3 conversion fails, rename WAV to MP3 (ffmpeg can handle it)
          console.log(
            "⚠️ MP3 conversion failed, using WAV format with MP3 extension"
          );
          fs.rename(tempWavPath, outPath, (renameErr) => {
            if (renameErr) reject(renameErr);
            else resolve();
          });
        });
    });
  });
}

function createWavHeader(samplesPerChannel, sampleRate, channels) {
  const byteRate = sampleRate * channels * 2; // 2 bytes per sample
  const blockAlign = channels * 2;
  const dataSize = samplesPerChannel * channels * 2;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);

  // fmt chunk
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // chunk size
  header.writeUInt16LE(1, 20); // audio format (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

function waitForFile(filePath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    function check() {
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          if (stats.size > 0) {
            resolve();
            return;
          }
        } catch (err) {
          // File exists but not readable yet
        }
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error(`File ${filePath} not ready after ${timeout}ms`));
        return;
      }

      setTimeout(check, 100);
    }

    check();
  });
}

function formatFFmpegPath(filePath) {
  const normalizedPath = path.normalize(filePath).replace(/\\/g, "/");
  return `file '${normalizedPath}'`;
}

async function alignAndMergeAudios(audio1, ts1, audio2, ts2, outputPath) {
  const dateFormat = "hh:mm:ss a";

  // Parse timestamps
  const startTime1 = parse(ts1, dateFormat, new Date());
  const startTime2 = parse(ts2, dateFormat, new Date());

  // Get durations
  const duration1 = await getDuration(audio1);
  const duration2 = await getDuration(audio2);

  // Calculate start times relative to the earliest start time
  const earliestStart = startTime1 <= startTime2 ? startTime1 : startTime2;
  const start1Sec = Math.abs(differenceInSeconds(startTime1, earliestStart));
  const start2Sec = Math.abs(differenceInSeconds(startTime2, earliestStart));

  // Calculate end times
  const end1Sec = start1Sec + duration1;
  const end2Sec = start2Sec + duration2;
  const totalDuration = Math.max(end1Sec, end2Sec);

  console.log(
    `📅 Audio 1: ${ts1} -> starts at ${start1Sec}s, ends at ${end1Sec}s (${duration1}s duration)`
  );
  console.log(
    `📅 Audio 2: ${ts2} -> starts at ${start2Sec}s, ends at ${end2Sec}s (${duration2}s duration)`
  );
  console.log(`🎵 Total timeline: ${totalDuration}s`);
  console.log(
    `⏰ Gap between audios: ${Math.abs(start2Sec - end1Sec)}s (${
      start2Sec > end1Sec ? "GAP EXISTS" : "OVERLAP/ADJACENT"
    })`
  );

  // Debug calculation
  console.log(
    `🔍 Debug: start1=${start1Sec}, end1=${end1Sec}, start2=${start2Sec}, end2=${end2Sec}`
  );
  console.log(
    `🔍 Debug: duration1=${duration1}, duration2=${duration2}, totalDuration=${totalDuration}`
  );

  const ext = path.extname(audio1);
  const finalList = temp("concat.txt");
  let filesToConcat = [];
  let tempFilesToCleanup = []; // Track all temporary files for cleanup

  // Create all significant time points and sort them
  const timePoints = [];

  // Always start from 0
  timePoints.push({ time: 0, type: "timeline_start" });

  // Add audio start/end points
  if (start1Sec > 0) timePoints.push({ time: start1Sec, type: "audio1_start" });
  timePoints.push({ time: end1Sec, type: "audio1_end" });

  if (start2Sec > 0) timePoints.push({ time: start2Sec, type: "audio2_start" });
  timePoints.push({ time: end2Sec, type: "audio2_end" });

  // Always end at total duration
  timePoints.push({ time: totalDuration, type: "timeline_end" });

  // Remove duplicates and sort
  const uniqueTimePoints = timePoints
    .filter(
      (point, index, array) =>
        array.findIndex((p) => Math.abs(p.time - point.time) < 0.01) === index
    )
    .sort((a, b) => a.time - b.time);

  console.log(
    "🎯 Timeline points:",
    uniqueTimePoints.map((p) => `${p.time}s (${p.type})`).join(", ")
  );

  // Create segments between time points
  for (let i = 0; i < uniqueTimePoints.length - 1; i++) {
    const currentTime = uniqueTimePoints[i].time;
    const nextTime = uniqueTimePoints[i + 1].time;
    const segmentDuration = nextTime - currentTime;

    if (segmentDuration <= 0.01) continue; // Skip tiny segments

    // Determine what audio(s) are active in this segment
    // Use a small epsilon to handle floating point precision issues
    const epsilon = 0.01;
    const audio1Active =
      currentTime >= start1Sec - epsilon && currentTime < end1Sec - epsilon;
    const audio2Active =
      currentTime >= start2Sec - epsilon && currentTime < end2Sec - epsilon;

    const segmentFile = temp(`segment_${i}${ext}`);

    console.log(
      `🎵 Creating segment ${i}: ${currentTime.toFixed(2)}s-${nextTime.toFixed(
        2
      )}s (${segmentDuration.toFixed(
        2
      )}s) - Audio1: ${audio1Active}, Audio2: ${audio2Active}`
    );

    if (!audio1Active && !audio2Active) {
      // Create silence
      console.log(
        `🔇 Creating silence segment: ${segmentDuration.toFixed(2)}s`
      );
      await createSilence(segmentDuration, segmentFile);

      // Verify the silence file was created
      await waitForFile(segmentFile);
      const actualSilenceDuration = await getDuration(segmentFile);
      console.log(
        `✅ Silence verification: expected ${segmentDuration.toFixed(
          2
        )}s, actual ${actualSilenceDuration.toFixed(2)}s`
      );
    } else if (audio1Active && !audio2Active) {
      // Only audio1 is active
      const audio1StartOffset = Math.max(0, currentTime - start1Sec);
      await new Promise((resolve, reject) => {
        ffmpeg(audio1)
          .setStartTime(audio1StartOffset)
          .setDuration(segmentDuration)
          .output(segmentFile)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else if (!audio1Active && audio2Active) {
      // Only audio2 is active
      const audio2StartOffset = Math.max(0, currentTime - start2Sec);
      await new Promise((resolve, reject) => {
        ffmpeg(audio2)
          .setStartTime(audio2StartOffset)
          .setDuration(segmentDuration)
          .output(segmentFile)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else {
      // Both audios are active - mix them
      const trim1 = temp(`trim1_${i}${ext}`);
      const trim2 = temp(`trim2_${i}${ext}`);

      // Add trim files to cleanup list
      tempFilesToCleanup.push(trim1, trim2);

      const audio1StartOffset = Math.max(0, currentTime - start1Sec);
      const audio2StartOffset = Math.max(0, currentTime - start2Sec);

      await Promise.all([
        new Promise((resolve, reject) => {
          ffmpeg(audio1)
            .setStartTime(audio1StartOffset)
            .setDuration(segmentDuration)
            .output(trim1)
            .on("end", resolve)
            .on("error", reject)
            .run();
        }),
        new Promise((resolve, reject) => {
          ffmpeg(audio2)
            .setStartTime(audio2StartOffset)
            .setDuration(segmentDuration)
            .output(trim2)
            .on("end", resolve)
            .on("error", reject)
            .run();
        }),
      ]);

      await Promise.all([waitForFile(trim1), waitForFile(trim2)]);

      // Mix the trimmed segments
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(trim1)
          .input(trim2)
          .complexFilter(
            "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]"
          )
          .outputOptions(["-map [a]", "-ac 2", "-ar 44100"])
          .output(segmentFile)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    await waitForFile(segmentFile);

    // Verify each segment duration
    const actualSegmentDuration = await getDuration(segmentFile);
    console.log(
      `✅ Segment ${i} verification: expected ${segmentDuration.toFixed(
        2
      )}s, actual ${actualSegmentDuration.toFixed(2)}s`
    );

    const normalizedSegment = temp(`normalized_${i}${ext}`);
    await normalizeAudioFormat(segmentFile, normalizedSegment);
    filesToConcat.push(normalizedSegment);
    tempFilesToCleanup.push(normalizedSegment);
  }

  // Create concat file
  const concatContent = filesToConcat.map(formatFFmpegPath).join("\n");
  fs.writeFileSync(finalList, concatContent, "utf8");

  console.log("📄 Concat file content:\n", concatContent);

  // Verify all files exist and log their durations
  let totalExpectedDuration = 0;
  for (const file of filesToConcat) {
    if (!fs.existsSync(file)) {
      throw new Error(`Referenced file does not exist: ${file}`);
    }
    const fileDuration = await getDuration(file);
    totalExpectedDuration += fileDuration;
    console.log(
      `✅ File exists: ${path.basename(file)} (${
        fs.statSync(file).size
      } bytes, ${fileDuration.toFixed(2)}s duration)`
    );
  }

  console.log(
    `🔍 Total expected duration from segments: ${totalExpectedDuration.toFixed(
      2
    )}s`
  );

  // Concatenate final output
  await new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(finalList)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .audioCodec("libmp3lame")
      .audioBitrate("128k")
      .audioFrequency(44100)
      .audioChannels(2)
      .output(outputPath)
      .on("start", (commandLine) => {
        console.log("🚀 FFmpeg command:", commandLine);
      })
      .on("end", resolve)
      .on("error", (err) => {
        console.error("❌ FFmpeg concatenation error:", err.message);
        // Try without copy codec as fallback
        console.log("🔄 Retrying concatenation with re-encoding...");

        ffmpeg()
          .input(finalList)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .audioCodec("libmp3lame")
          .audioBitrate(128)
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

    command.run();
  });

  console.log("✅ Final audio created at", outputPath);

  const finalDuration = await getDuration(outputPath);
  console.log(
    `🎯 Expected duration: ${totalDuration.toFixed(
      2
    )}s, Actual duration: ${finalDuration.toFixed(2)}s`
  );

  if (Math.abs(finalDuration - totalDuration) > 1) {
    console.warn(
      `⚠️ Duration mismatch detected! Expected: ${totalDuration.toFixed(
        2
      )}s, Got: ${finalDuration.toFixed(2)}s`
    );
  } else {
    console.log("🎉 Duration matches expected timeline!");
  }

  // Cleanup temporary files
  const allTempFiles = [finalList, ...tempFilesToCleanup];
  allTempFiles.forEach((file) => {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        console.log(`🧹 Cleaned up: ${path.basename(file)}`);
      } catch (err) {
        console.warn(`⚠️ Could not clean up ${file}:`, err.message);
      }
    }
  });

  return totalDuration;
}

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const audio1 = path.join(__dirname, "input", "ps.mp3");
const audio2 = path.join(__dirname, "input", "sa.mp3");

// Test scenarios
async function runTests() {
  try {
    console.log("🎵 Starting audio alignment tests...\n");

    // Scenario 1: Overlapping
    console.log("📍 Test 1: Overlapping scenario");
    console.log("Audio 1: 2:00:30 PM -> Audio 2: 2:01:10 PM (40s later)");
    await alignAndMergeAudios(
      audio1,
      "2:00:30 PM",
      audio2,
      "2:01:10 PM",
      temp("output1.mp3")
    );

    console.log("\n" + "=".repeat(50) + "\n");

    console.log("📍 Test 2: Gap scenario");
    console.log("Audio 1: 2:00:30 PM -> Audio 2: 2:08:00 PM (450s later)");
    await alignAndMergeAudios(
      audio1,
      "2:00:30 PM",
      audio2,
      "2:08:00 PM",
      temp("output2.mp3")
    );

    console.log("\n🎉 All tests completed successfully!");
  } catch (error) {
    console.error("💥 Error during processing:", error);
  }
}

module.exports = { alignAndMergeAudios };
