const YAML = require('yamljs');

describe('OpenAPI regression coverage', () => {
    let spec;

    beforeAll(() => {
        spec = YAML.load('openapi.yaml');
    });

    test('defines JWT bearer auth so Swagger UI can authorize protected routes', () => {
        expect(spec.components.securitySchemes.bearerAuth).toEqual({
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
        });
        expect(spec.security).toEqual([{ bearerAuth: [] }]);
    });

    test('documents runtime object state endpoint and decoded object values', () => {
        const pathSpec = spec.paths['/api/bacnet/runtime-objects/{deviceId}'];

        expect(pathSpec.get.summary).toContain('runtime BACnet object state');
        expect(pathSpec.get.parameters).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'deviceId', in: 'path', required: true })
        ]));
        expect(pathSpec.get.responses['200'].content['application/json'].schema.items.$ref)
            .toBe('#/components/schemas/RuntimeObjectState');
        expect(spec.components.schemas.RuntimeObjectState.properties.value.oneOf)
            .toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'number' }),
                expect.objectContaining({ type: 'boolean' })
            ]));
    });

    test('documents configured device object metadata for diagnostics', () => {
        const pathSpec = spec.paths['/api/bacnet/configured'];

        expect(pathSpec.get.summary).toContain('configured BACnet devices');
        expect(pathSpec.get.responses['200'].content['application/json'].schema.items.$ref)
            .toBe('#/components/schemas/ConfiguredDevice');
        expect(spec.components.schemas.ConfiguredDevice.properties.objects.items.$ref)
            .toBe('#/components/schemas/ConfiguredDeviceObject');
        expect(spec.components.schemas.ConfiguredDeviceObject.properties.objectKey.example)
            .toBe('2_202');
    });
});
