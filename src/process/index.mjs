/**
 * SoberAF Sticker Studio - Image Processing Lambda
 *
 * This function is triggered automatically when a new image lands in the
 * raw S3 bucket. It performs three jobs on every image:
 *
 *   1. Background removal — runs the raw PNG through @imgly/background-removal-node,
 *      a U²-Net based ML model that produces a clean transparent cutout of
 *      the subject regardless of what background the image generator put
 *      behind it. This is the same model family as the Python `rembg` tool
 *      and is the only reliable way to handle the variety of unwanted
 *      backgrounds (drop shadows, dark circles, ground hatching, etc.) that
 *      generative image models occasionally add even when transparency is
 *      requested.
 *
 *   2. Multi-size resizing — produces small/medium/large print sizes at
 *      300 DPI, matching common print-on-demand sticker dimensions.
 *
 *   3. Watermarking — adds a subtle "SoberAF" brand mark so gallery
 *      previews aren't free to lift.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { removeBackground } from '@imgly/background-removal-node';
import sharp from 'sharp';

const s3 = new S3Client();
const dynamoClient = new DynamoDBClient();
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

// Sticker sizes to generate (in pixels)
// These map to common print-on-demand sticker dimensions at 300 DPI
const STICKER_SIZES = [
  { name: 'small',  width: 600,  height: 600,  label: '2x2 inch' },
  { name: 'medium', width: 900,  height: 900,  label: '3x3 inch' },
  { name: 'large',  width: 1200, height: 1200, label: '4x4 inch' },
];

// Background-removal config passed to @imgly/background-removal-node.
// "medium" is the sweet spot — it's the U²-Net base model that handles
// arbitrary subjects and arbitrary backgrounds correctly, and it fits
// comfortably in 1024 MB of Lambda memory.
const BG_REMOVAL_CONFIG = {
  model: 'medium',
  output: { format: 'image/png', quality: 0.9 },
};

export const handler = async (event) => {
  console.log('Process Lambda invoked:', JSON.stringify(event));

  try {
    // Get the S3 event details
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log(`Processing image: ${bucket}/${key}`);

    // Extract the design ID from the S3 key (format: {designId}/original.png)
    const designId = key.split('/')[0];

    // Download the raw image from S3
    const rawImage = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    const imageBuffer = Buffer.from(await rawImage.Body.transformToByteArray());
    console.log('Raw image downloaded, size:', imageBuffer.length);

    // STEP 1: Run the raw image through the background-removal model.
    // Returns a clean transparent PNG of the subject with no shadows,
    // ground, or other artifacts the image generator may have added.
    const cleanedBuffer = await removeImageBackground(imageBuffer);
    console.log('Background removed, size:', cleanedBuffer.length);

    // STEP 2: Resize into each sticker size and add the watermark.
    const processedKeys = {};

    for (const size of STICKER_SIZES) {
      const processedBuffer = await processImage(cleanedBuffer, size);

      const processedKey = `${designId}/${size.name}.png`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.PROCESSED_BUCKET,
        Key: processedKey,
        Body: processedBuffer,
        ContentType: 'image/png',
        Metadata: {
          'design-id': designId,
          'size-name': size.name,
          'size-label': size.label,
          'dimensions': `${size.width}x${size.height}`,
        },
      }));

      processedKeys[size.name] = processedKey;
      console.log(`Processed ${size.name} (${size.label}): ${processedKey}`);
    }

    // Update DynamoDB metadata with processed image info
    const timestamp = new Date().toISOString();
    await dynamo.send(new UpdateCommand({
      TableName: process.env.METADATA_TABLE,
      Key: { designId: designId },
      UpdateExpression: 'SET #status = :status, processedKeys = :keys, processedAt = :ts, updatedAt = :ts',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'processed',
        ':keys': processedKeys,
        ':ts': timestamp,
      },
    }));
    console.log('DynamoDB metadata updated for:', designId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Image processed successfully',
        designId: designId,
        sizes: Object.keys(processedKeys),
      }),
    };

  } catch (error) {
    console.error('Error in process function:', error);
    throw error;
  }
};

/**
 * Runs the raw generated image through the @imgly/background-removal-node
 * U²-Net model and returns a clean transparent PNG of just the subject.
 *
 * This is the only background-handling step in the pipeline. No flood
 * fill, no thresholds, no connected-components heuristics — the ML model
 * handles everything, including subjects on top of opaque shadows or
 * decorative backgrounds the image generator may have added.
 *
 * If the model fails for any reason, we fall back to passing the original
 * image through unchanged so the rest of the pipeline still completes.
 */
async function removeImageBackground(imageBuffer) {
  try {
    const blob = await removeBackground(imageBuffer, BG_REMOVAL_CONFIG);
    const arrayBuffer = await blob.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('Background removal failed, falling back to raw image:', err);
    return await sharp(imageBuffer).png({ compressionLevel: 9 }).toBuffer();
  }
}

/**
 * Resizes a die-cut sticker to the target dimensions and adds a subtle
 * watermark in the bottom-right corner. Preserves the alpha channel so
 * the transparent background survives through resizing and compositing.
 */
async function processImage(dieCutBuffer, size) {
  // Create the watermark SVG — subtle "SoberAF" text in the bottom-right corner.
  // Uses a dark semi-transparent fill so it reads against the white border
  // (where it will usually land) without being obtrusive on colored artwork.
  const watermarkSvg = `
    <svg width="${size.width}" height="${size.height}">
      <style>
        .watermark {
          fill: rgba(0, 0, 0, 0.35);
          font-size: ${Math.round(size.width * 0.035)}px;
          font-family: Arial, sans-serif;
          font-weight: bold;
        }
      </style>
      <text x="${size.width - 12}" y="${size.height - 12}"
            text-anchor="end" class="watermark">SoberAF</text>
    </svg>`;

  const watermarkBuffer = Buffer.from(watermarkSvg);

  // Resize preserving alpha, then composite the watermark on top.
  // fit: 'contain' with a transparent background ensures the die-cut
  // silhouette is preserved even if the image isn't perfectly square.
  const processed = await sharp(dieCutBuffer)
    .resize(size.width, size.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .composite([{
      input: watermarkBuffer,
      top: 0,
      left: 0,
    }])
    .png({
      compressionLevel: 9,
    })
    .toBuffer();

  return processed;
}
