import dynamoDb from '../config/dynamoDb.js';
import { retryWithBackoff } from '../utils/retry.js';


const TABLE = "JobHunterJobs"

export async function upsertJob(item) {
  const now = new Date().toISOString();
  item.createdAt = item.createdAt || now;
  item.updatedAt = now;
  if (!item.jobId) throw new Error('jobId required');
  const params = { TableName: TABLE, Item: item };
  return retryWithBackoff(() => dynamoDb.put(params).promise());
}

export async function batchUpsert(items = []) {
  if (!items.length) return;
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) chunks.push(items.slice(i, i + 25));
  for (const chunk of chunks) {
    const putRequests = chunk.map(it => ({ PutRequest: { Item: it } }));
    const params = { RequestItems: { [TABLE]: putRequests } };
    await retryWithBackoff(() => dynamoDb.batchWrite(params).promise());
  }
}

export async function getJobById(jobId) {
  const params = { TableName: TABLE, Key: { jobId } };
  const res = await retryWithBackoff(() => dynamoDb.get(params).promise());
  return res.Item || null;
}

export async function scanJobs({ limit = 20, exclusiveStartKey, filterExpression, expressionAttributeNames, expressionAttributeValues } = {}) {
  const params = { TableName: TABLE, Limit: limit };
  if (exclusiveStartKey) params.ExclusiveStartKey = exclusiveStartKey;
  if (filterExpression) params.FilterExpression = filterExpression;
  if (expressionAttributeNames) params.ExpressionAttributeNames = expressionAttributeNames;
  if (expressionAttributeValues) params.ExpressionAttributeValues = expressionAttributeValues;
  const res = await retryWithBackoff(() => dynamoDb.scan(params).promise());
  return { items: res.Items || [], lastEvaluatedKey: res.LastEvaluatedKey };
}
