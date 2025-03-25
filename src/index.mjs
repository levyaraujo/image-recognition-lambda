import { RekognitionClient, DetectTextCommand } from '@aws-sdk/client-rekognition'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

export async function handler(event) {
  const rekognitionClient = new RekognitionClient({ region: 'us-east-1' });
  const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

  const [record] = event.Records;
  const bucket = record.s3.bucket;
  const object = record.s3.object;

  const extractedText = await detectTextInS3Image(rekognitionClient, bucket.name, object.key);

  const paymentInfo = await extractPaymentInfoWithBedrock(bedrockClient, extractedText);
  paymentInfo.user = object.key.split('-')[0];

  await sendPaymentInfo(paymentInfo);
}

async function detectTextInS3Image(rekognitionClient, bucket, key) {
  const params = {
    Image: {
      S3Object: {
        Bucket: bucket,
        Name: key,
      },
    }
  };

  const command = new DetectTextCommand(params);

  try {
    const response = await rekognitionClient.send(command);

    let extractedText = ``

    response.TextDetections.forEach(text => {
      extractedText += `${text.DetectedText} `;
      if (text.id === 15) {
        extractedText += '\n';
      }
    });

    console.log("EXTRACTED TEXT >>>> ", extractedText);

    return extractedText;

  } catch (error) {
    console.error("Error detecting text:", error);
    throw error;
  }
}

async function extractPaymentInfoWithBedrock(bedrockClient, text) {
  const modelId = process.env.MODEL_ID;

  let prompt = `
<text>
  ${text}
</text>
The text above is extracted from a payment receipt in Portuguese. Be concise to avoid errors.
Extract the following structured information:

1. The amount paid (value) with discount if mentioned
2. The payment date
3. The institution that received the payment (the payee)
  - This is found normally in the "Destino", "nome Favorecido" section
  - Look specifically for the entity name after "Nome" in the "Destino" section
  - The institution is the entity receiving the payment (not the bank handling the transaction)
  - Common examples include utility companies, government agencies, service providers, etc. (not the bank itself)

  Respond ONLY with a JSON object in the following format:

{
  "amount": [the amount as a float number],
  "payment_date": "[yyyy-mm-dd, if it doesnt have a year or the full date, use the current year, month and day if necessary]",
  "institution": "[full name of the recipient entity]"
}
`

  const params = {
    modelId: modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 512,
      temperature: 0.1
    })
  };

  try {
    const command = new InvokeModelCommand(params);
    const response = await bedrockClient.send(command);

    const responseBody = Buffer.from(response.body).toString('utf-8');
    const parsedResponse = JSON.parse(responseBody);

    try {
      console.log("RESPONSE >>>> ", responseBody);
      const content = parsedResponse.choices[0].message.content;
      const paymentInfo = JSON.parse(content);
      return paymentInfo;
    } catch (jsonError) {
      console.error("Error parsing JSON from Deepseek response:", jsonError);
    }
  } catch (error) {
    console.error("Error invoking Bedrock model:", error);
    throw error;
  }
}

async function sendPaymentInfo(paymentInfo) {
  const endpoint = process.env.CREATE_TRANSACTION_ENDPOINT;


  console.log("ENDPOINT >>>> ", endpoint);
  console.log("PAYMENT INFO >>>> ", paymentInfo);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paymentInfo),
    });

    if (!response.ok) {
      const errorBody = await response.text(); // Log the response body for debugging
      throw new Error(`Failed to send payment info: ${response.statusText}. Response: ${errorBody}`);
    }

    const responseData = await response.json();
    console.log('Payment info successfully sent:', responseData);
  } catch (error) {
    console.error('Error sending payment info:', error);
  }
}