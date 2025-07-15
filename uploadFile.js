// supabase-upload.js
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function uploadRecordingToSupabase(filePath, roomId) {
  try {
    // Read the file from the local filesystem
    const fileBuffer = fs.readFileSync(filePath);

    // Generate a unique filename
    const fileName = `room_${roomId}_recording_${Date.now()}.mp3`;

    console.log(
      `Uploading file to Supabase: ${fileName}, Size: ${fileBuffer.length} bytes`
    );

    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from("recordings")
      .upload(fileName, fileBuffer, {
        cacheControl: "3600",
        upsert: false,
        contentType: "audio/mpeg",
      });

    if (error) {
      console.error("Supabase upload error:", error);
      throw error;
    }

    console.log("Upload successful:", data);

    // Get the public URL
    const { data: publicData } = supabase.storage
      .from("recordings")
      .getPublicUrl(fileName);

    console.log("Public URL:", publicData.publicUrl);

    return publicData.publicUrl;
  } catch (error) {
    console.error("Error uploading recording to Supabase:", error);
    throw error;
  }
}

module.exports = {
  uploadRecordingToSupabase,
};
