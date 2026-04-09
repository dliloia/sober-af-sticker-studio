/**
 * SoberAF Sticker Studio - Image Processing Lambda
 *
 * This function is triggered automatically when a new image lands in the
 * raw S3 bucket. It processes the image into multiple sticker-ready sizes,
 * adds a subtle watermark, optimizes file size, and stores the results
 * in the processed S3 bucket. It also updates the DynamoDB metadata.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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

    // Process the image into each sticker size
    const processedKeys = {};

    for (const size of STICKER_SIZES) {
      const processedBuffer = await processImage(imageBuffer, size);

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
 * Processes an image: resizes to the target dimensions, adds a subtle
 * watermark, and optimizes for quality/file size balance.
 */
async function processImage(imageBuffer, size) {
  // Create the watermark SVG — subtle "SoberAF" text in the bottom-right corner
  const watermarkSvg = `
    <svg width="${size.width}" height="${size.height}">
      <style>
        .watermark {
          fill: rgba(255, 255, 255, 0.4);
          font-size: ${Math.round(size.width * 0.04)}px;
          font-family: Arial, sans-serif;
          font-weight: bold;
        }
      </style>
      <text x="${size.width - 10}" y="${size.height - 10}"
            text-anchor="end" class="watermark">SoberAF</text>
    </svg>`;

  const watermarkBuffer = Buffer.from(watermarkSvg);

  // Resize the image and composite the watermark
  const processed = await sharp(imageBuffer)
    .resize(size.width, size.height, {
      fit: 'cover',
      position: 'centre',
    })
    .composite([{
      input: watermarkBuffer,
      top: 0,
      left: 0,
    }])
    .png({
      quality: 90,
      compressionLevel: 8,
    })
    .toBuffer();

  return processed;
}
