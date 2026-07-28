export interface MqttTopicSettings {
  baseTopic: string;
  discoveryPrefix: string;
}

// MAC-based device ids (e.g. "A0:14:3D:CD:A3:D3") contain ':', invalid in an MQTT topic segment
// and in HA's discovery node_id — sanitized once here, everywhere a topic is built from a device id.
export function sanitizeDeviceId(deviceId: string): string {
  return deviceId.replace(/:/g, '').toLowerCase();
}

export function availabilityTopic(baseTopic: string): string {
  return `${baseTopic}/bridge/status`;
}

export function stateTopic(baseTopic: string, deviceId: string): string {
  return `${baseTopic}/${sanitizeDeviceId(deviceId)}/state`;
}

export function healthTopic(baseTopic: string, deviceId: string): string {
  return `${baseTopic}/${sanitizeDeviceId(deviceId)}/health`;
}

export function wateringCommandTopic(baseTopic: string, deviceId: string): string {
  return `${baseTopic}/${sanitizeDeviceId(deviceId)}/watering/set`;
}

export function wateringCommandFilter(baseTopic: string): string {
  return `${baseTopic}/+/watering/set`;
}

export function wateringResultTopic(baseTopic: string, deviceId: string): string {
  return `${baseTopic}/${sanitizeDeviceId(deviceId)}/watering/result`;
}

export function discoveryConfigTopic(discoveryPrefix: string, component: string, deviceId: string, objectId: string): string {
  return `${discoveryPrefix}/${component}/stroyplant_${sanitizeDeviceId(deviceId)}/${objectId}/config`;
}
