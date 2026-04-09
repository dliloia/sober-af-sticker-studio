/**
 * SoberAF Sticker Studio - Image Generation Lambda
 *
 * This function receives a user prompt via API Gateway, prepends the
 * house style prefix to maintain brand consistency, calls the OpenAI
 * DALL-E 3 API to generate the image, and stores the result in S3.
 * It also writes metadata to DynamoDB for the frontend gallery.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const s3 = new S3Client();
const dynamoClient = new DynamoDBClient();
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

// House style prefix — ensures every generated image looks like a SoberAF sticker
const STYLE_PREFIX = `A die-cut sticker design on a clean white background, bold cartoon style,
vibrant and saturated colors, thick clean outlines, no text or words on the sticker,
simple and playful illustration suitable for print-on-demand sticker production: `;

export const handler = async (event) => {
  console.log('Generate Lambda invoked:', JSON.stringify(event));

  try {
    // Parse the incoming request
    const body = JSON.parse(event.body);
    const userPrompt = body.prompt;

    if (!userPrompt || userPrompt.trim() === '') {
      return buildResponse(400, { error: 'Prompt is required' });
    }

    // Generate a unique design ID
    const designId = randomUUID();
    const timestamp = new Date().toISOString();

    // Build the full prompt with house style
    const fullPrompt = STYLE_PREFIX + userPrompt;
    console.log('Full prompt:', fullPrompt);

    // Call OpenAI DALL-E 3 API
    const imageUrl = await generateImage(fullPrompt);

    // Download the generated image
    const imageBuffer = await downloadImage(imageUrl);

    // Store raw image in S3
    const s3Key = `${designId}/original.png`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.RAW_BUCKET,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/png',
      Metadata: {
        'design-id': designId,
        'user-prompt': userPrompt,
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
 * Calls the OpenAI DALL-E 3 API to generate an image from a prompt.
 */
async function generateImage(prompt) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'url',
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data.data[0].url;
}

/**
 * Downloads an image from a URL and returns it as a Buffer.
 */
async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
