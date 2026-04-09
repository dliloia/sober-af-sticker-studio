/**
 * SoberAF Sticker Studio - List Designs Lambda
 *
 * Returns all sticker designs from DynamoDB, sorted by creation date
 * (newest first). Used by the frontend gallery to display designs.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient();
const dynamo = DynamoDBDocumentClient.from(dynamoClient);

export const handler = async (event) => {
  console.log('ListDesigns Lambda invoked');

  try {
    const result = await dynamo.send(new ScanCommand({
      TableName: process.env.METADATA_TABLE,
    }));

    // Sort by creation date, newest first
    const designs = (result.Items || []).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({ designs }),
    };

  } catch (error) {
    console.error('Error listing designs:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'Failed to retrieve designs',
        details: error.message,
      }),
    };
  }
};
