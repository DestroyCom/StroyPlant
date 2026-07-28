import type { Device } from '@prisma/client';
import { availabilityTopic, healthTopic, sanitizeDeviceId, stateTopic, wateringCommandTopic, wateringResultTopic } from './topics.js';

export interface DiscoveryEntity {
  component: 'sensor' | 'button';
  objectId: string;
  payload: Record<string, unknown>;
}

type DeviceForDiscovery = Pick<Device, 'id' | 'name' | 'kind'>;

function haDeviceInfo(device: DeviceForDiscovery) {
  return {
    identifiers: [sanitizeDeviceId(device.id)],
    name: device.name ?? device.id,
    manufacturer: device.kind === 'PARROT_POT' ? 'Parrot' : 'Xiaomi',
    model: device.kind === 'PARROT_POT' ? 'Pot' : 'LYWSD03MMC',
  };
}

// Home Assistant MQTT discovery format (https://www.home-assistant.io/integrations/mqtt/#discovery-topic) —
// one retained config payload per entity, all sharing the same per-device JSON state topic via
// `value_template` (avoids one raw topic per sensor field). Only called for named/claimed devices
// (docs/STROYPLANT_SPEC.md section 7.2's "Add device" flow) — an unclaimed device isn't tracked
// anywhere else in the app either.
export function buildDiscoveryEntities(device: DeviceForDiscovery, baseTopic: string): DiscoveryEntity[] {
  const state = stateTopic(baseTopic, device.id);
  const health = healthTopic(baseTopic, device.id);
  const common = { availability_topic: availabilityTopic(baseTopic), device: haDeviceInfo(device) };
  const uid = (suffix: string) => `stroyplant_${sanitizeDeviceId(device.id)}_${suffix}`;

  const entities: DiscoveryEntity[] = [];

  if (device.kind === 'PARROT_POT') {
    entities.push(
      {
        component: 'sensor',
        objectId: 'soil_moisture',
        payload: {
          ...common,
          name: 'Humidité du sol',
          unique_id: uid('soil_moisture'),
          state_topic: state,
          value_template: '{{ value_json.soilMoisturePercent }}',
          unit_of_measurement: '%',
          state_class: 'measurement',
        },
      },
      {
        component: 'sensor',
        objectId: 'temperature',
        payload: {
          ...common,
          name: 'Température',
          unique_id: uid('temperature'),
          state_topic: state,
          value_template: '{{ value_json.temperatureC }}',
          unit_of_measurement: '°C',
          device_class: 'temperature',
          state_class: 'measurement',
        },
      },
      {
        component: 'sensor',
        objectId: 'luminosity',
        payload: {
          ...common,
          name: 'Luminosité',
          unique_id: uid('luminosity'),
          state_topic: state,
          value_template: '{{ value_json.luminosity }}',
          unit_of_measurement: 'mol/m²/j',
          state_class: 'measurement',
        },
      },
      {
        component: 'sensor',
        objectId: 'reservoir',
        payload: {
          ...common,
          name: 'Niveau du réservoir',
          unique_id: uid('reservoir'),
          state_topic: state,
          value_template: '{{ value_json.waterTankLevelPercent }}',
          unit_of_measurement: '%',
          state_class: 'measurement',
        },
      },
      {
        component: 'button',
        objectId: 'watering',
        payload: {
          ...common,
          name: 'Arroser maintenant',
          unique_id: uid('watering_button'),
          command_topic: wateringCommandTopic(baseTopic, device.id),
          payload_press: 'PRESS',
        },
      },
      {
        component: 'sensor',
        objectId: 'watering_last_result',
        payload: {
          ...common,
          name: 'Dernier arrosage',
          unique_id: uid('watering_last_result'),
          state_topic: wateringResultTopic(baseTopic, device.id),
          value_template: '{{ value_json.success }}',
          json_attributes_topic: wateringResultTopic(baseTopic, device.id),
        },
      },
    );
  } else {
    entities.push(
      {
        component: 'sensor',
        objectId: 'temperature',
        payload: {
          ...common,
          name: 'Température',
          unique_id: uid('temperature'),
          state_topic: state,
          value_template: '{{ value_json.temperatureC }}',
          unit_of_measurement: '°C',
          device_class: 'temperature',
          state_class: 'measurement',
        },
      },
      {
        component: 'sensor',
        objectId: 'humidity',
        payload: {
          ...common,
          name: 'Humidité',
          unique_id: uid('humidity'),
          state_topic: state,
          value_template: '{{ value_json.humidityPercent }}',
          unit_of_measurement: '%',
          device_class: 'humidity',
          state_class: 'measurement',
        },
      },
      {
        component: 'sensor',
        objectId: 'battery',
        payload: {
          ...common,
          name: 'Batterie',
          unique_id: uid('battery'),
          state_topic: state,
          value_template: '{{ value_json.batteryPercent }}',
          unit_of_measurement: '%',
          device_class: 'battery',
          state_class: 'measurement',
        },
      },
    );
  }

  // Only meaningful once a species is assigned (computeDeviceHealth returns 'no_profile'
  // otherwise) — still declared unconditionally, HA just shows "unknown" until a health state is
  // ever published for this device (see mqtt/publisher.ts's publishHealthState).
  entities.push({
    component: 'sensor',
    objectId: 'health_status',
    payload: {
      ...common,
      name: 'Statut santé',
      unique_id: uid('health_status'),
      state_topic: health,
      value_template: '{{ value_json.status }}',
      json_attributes_topic: health,
    },
  });

  return entities;
}
