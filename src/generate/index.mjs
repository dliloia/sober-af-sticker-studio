/**
 * SoberAF Sticker Studio - Image Generation Lambda
 *
 * This function receives a user prompt via API Gateway, prepends the
 * house style prefix to maintain brand consistency, calls the OpenAI
 * gpt-image-1 API with background:"transparent" to generate the image
 * with a pre-baked alpha channel, and stores the result in S3. It also
 * writes metadata to DynamoDB for the frontend gallery.
 *
 * Using gpt-image-1 with transparent background means the Process Lambda
 * no longer has to guess where the background is — the model hands us a
 * PNG whose alpha channel is already the correct sticker cutout.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const s3 = new S3Client();
const dynamoClient = new DynamoDBClient();
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

// House style prefix — kept deliberately minimal. gpt-image-1 is handling
// the transparent background for us, so we only need to insist the subject
// is fully isolated. We explicitly forbid shadows, ground, base, surface,
// and any "floor" the model might otherwise add — those come back as opaque
// pixels even when background:"transparent" is set, and have to be cleaned
// up downstream.
const STYLE_PREFIX = `A clean centered illustration of an isolated subject with absolutely no background, no scene, no environment, no shadow, no drop shadow, no ground, no floor, no surface, no base, no platform, no pedestal, no reflection. The subject must be the only opaque content in the image and must float on a fully transparent background. The subject shows: `;

// When the user supplies text to appear on the sticker, we append this suffix.
// Single-quoting the text and flagging it as "exact spelling" improves text
// rendering accuracy. We lean on the Regenerate button in the UI to catch
// the occasional mis-spelling.
function buildTextSuffix(stickerText) {
  const cleaned = stickerText.trim();
  if (!cleaned) return '';
  return `. The illustration must prominently feature the following text with exact correct spelling, letter for letter: '${cleaned}'. The text should be integrated into the artwork as a banner, scroll, ribbon, or bold display typography`;
}

export const handler = async (event) => {
  console.log('Generate Lambda invoked:', JSON.stringify(event));

  try {
    // Parse the incoming request
    const body = JSON.parse(event.body);
    const userPrompt = body.prompt;
    const stickerText = (body.text || '').toString();

    if (!userPrompt || userPrompt.trim() === '') {
      return buildResponse(400, { error: 'Prompt is required' });
    }

    // Generate a unique design ID
    const designId = randomUUID();
    const timestamp = new Date().toISOString();

    // Build the full prompt: house style + concept + optional text suffix.
    // The text suffix is only added when the caller supplied sticker text.
    const fullPrompt = STYLE_PREFIX + userPrompt + buildTextSuffix(stickerText);
    console.log('Full prompt:', fullPrompt);

    // Call OpenAI gpt-image-1 — returns the PNG bytes directly (base64).
    const imageBuffer = await generateImage(fullPrompt);

    // Store raw image in S3
    const s3Key = `${designId}/original.png`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.RAW_BUCKET,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/png',
      Metadata: {
        'design-id': designId,
        'generated-at': timestamp,
      },
    }));
    console.log('Raw image stored in S3:', s3Key);

    // Write metadata to DynamoDB
    await dynamo.send(new PutCommand({
      TableName: process.env.METADATA_TABLE,
      Item: {
        designId: designId,
        userPrompt: userPrompt,
        stickerText: stickerText || null,
        fullPrompt: fullPrompt,
        status: 'raw',
        rawKey: s3Key,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }));
    console.log('Metadata written to DynamoDB:', designId);

    return buildResponse(200, {
      message: 'Sticker design generated successfully',
      designId: designId,
      prompt: userPrompt,
      text: stickerText || null,
      status: 'raw',
      timestamp: timestamp,
    });

  } catch (error) {
    console.error('Error in generate function:', error);
    return buildResponse(500, {
      error: 'Failed to generate sticker design',
      details: error.message,
    });
  }
};

/**
 * Calls the OpenAI gpt-image-1 API to generate an image from a prompt.
 *
 * We request background:"transparent" so the returned PNG has a real
 * alpha channel — the sticker cutout is pre-baked by the model. This
 * eliminates the flaky background-removal step that the Process Lambda
 * used to have to do by hand.
 *
 * gpt-image-1 only returns base64 (no URL), so we decode it inline
 * instead of calling a separate downloadImage step.
 */
async function generateImage(prompt) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      output_format: 'png',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const b64 = data.data[0].b64_json;
  if (!b64) {
    throw new Error('OpenAI response did not include b64_json image data');
  }
  return Buffer.from(b64, 'base64');
}

/**
 * Builds a standardized API Gateway response with CORS headers.
 */
function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}
