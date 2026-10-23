import { Inject, Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { Env } from '../../config/env';
import { OutboxMessage } from '../../domain/messaging/outbox-message';

@Injectable()
export class SqsGateway {
  readonly client: SQSClient;

  constructor(@Inject('ENV') private readonly env: Env) {
    this.client = new SQSClient({
      region: env.awsRegion,
      endpoint: env.sqsEndpoint,
      credentials: {
        accessKeyId: env.awsAccessKeyId,
        secretAccessKey: env.awsSecretAccessKey,
      },
    });
  }

  async ready(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.env.wagerQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async receiveWagers(): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.env.wagerQueueUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 20,
        VisibilityTimeout: this.env.sqsVisibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return response.Messages ?? [];
  }

  async deleteWager(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.env.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async releaseWager(receiptHandle: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.env.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  async retryWager(receiptHandle: string, receiveCount: number): Promise<void> {
    const timeout = Math.min(60, 2 ** Math.max(1, receiveCount));
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.env.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeout,
      }),
    );
  }

  async sendToDlq(body: string, groupId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.wagerDlqUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: `${groupId}:${Date.now()}:${Math.random()}`,
      }),
    );
  }

  async publishEvent(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.eventsQueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  async sendWager(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.env.wagerQueueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
}
