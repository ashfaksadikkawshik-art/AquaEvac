-- Add Dhaka landmarks to the existing demo safe-route graph.
-- Import this once into aquaevac_db after schema.sql (or into an existing install).
-- Re-running is safe: each edge is inserted only if that unordered pair is absent.
-- Coordinates are approximate neighborhood points in app.py/app.js; these are
-- demonstration connectors, not verified road centerlines or live hazard data.
USE aquaevac_db;

-- Normalize the earlier NewMarket key to the user-facing spelling.
UPDATE roads_graph SET node_a = 'New Market' WHERE node_a = 'NewMarket';
UPDATE roads_graph SET node_b = 'New Market' WHERE node_b = 'NewMarket';

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Agargaon', 'Shyamoli', 1.721, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Agargaon' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Agargaon'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kallyanpur', 'Shyamoli', 1.665, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kallyanpur' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Kallyanpur'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Asad Gate', 'Mohammadpur', 1.414, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Asad Gate' AND node_b = 'Mohammadpur') OR (node_a = 'Mohammadpur' AND node_b = 'Asad Gate'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mohammadpur Bus Stand', 'Mohammadpur', 0.307, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mohammadpur Bus Stand' AND node_b = 'Mohammadpur') OR (node_a = 'Mohammadpur' AND node_b = 'Mohammadpur Bus Stand'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Gabtoli', 'Shyamoli', 2.974, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Gabtoli' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Gabtoli'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Technical Mor', 'Shyamoli', 2.720, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Technical Mor' AND node_b = 'Shyamoli') OR (node_a = 'Shyamoli' AND node_b = 'Technical Mor'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Bijoy Sarani', 'Tejgaon', 0.619, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Bijoy Sarani' AND node_b = 'Tejgaon') OR (node_a = 'Tejgaon' AND node_b = 'Bijoy Sarani'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Manik Mia Avenue', 'Farmgate', 1.613, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Manik Mia Avenue' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Manik Mia Avenue'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Elephant Road', 'New Market', 0.780, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Elephant Road' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Elephant Road'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Science Lab', 'New Market', 0.875, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Science Lab' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Science Lab'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kalabagan', 'Dhanmondi', 1.234, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kalabagan' AND node_b = 'Dhanmondi') OR (node_a = 'Dhanmondi' AND node_b = 'Kalabagan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Panthapath', 'Farmgate', 0.894, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Panthapath' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Panthapath'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Hatirpool', 'New Market', 1.818, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Hatirpool' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Hatirpool'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Eskaton', 'Malibagh', 1.509, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Eskaton' AND node_b = 'Malibagh') OR (node_a = 'Malibagh' AND node_b = 'Eskaton'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kakrail', 'Motijheel', 0.742, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kakrail' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Kakrail'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Segunbagicha', 'Motijheel', 1.482, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Segunbagicha' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Segunbagicha'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Purana Paltan', 'Motijheel', 0.544, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Purana Paltan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Purana Paltan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Gulistan', 'Motijheel', 1.537, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Gulistan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Gulistan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Wari', 'OldTown', 1.696, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Wari' AND node_b = 'OldTown') OR (node_a = 'OldTown' AND node_b = 'Wari'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mugda', 'Motijheel', 2.998, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mugda' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Mugda'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Basabo', 'Motijheel', 2.072, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Basabo' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Basabo'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Aftabnagar', 'Rampura', 1.639, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Aftabnagar' AND node_b = 'Rampura') OR (node_a = 'Rampura' AND node_b = 'Aftabnagar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Merul Badda', 'Badda', 0.984, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Merul Badda' AND node_b = 'Badda') OR (node_a = 'Badda' AND node_b = 'Merul Badda'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Natun Bazar', 'Badda', 1.766, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Natun Bazar' AND node_b = 'Badda') OR (node_a = 'Badda' AND node_b = 'Natun Bazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Mohakhali', 'Gulshan', 1.468, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Mohakhali' AND node_b = 'Gulshan') OR (node_a = 'Gulshan' AND node_b = 'Mohakhali'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Moghbazar', 'Malibagh', 0.532, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Moghbazar' AND node_b = 'Malibagh') OR (node_a = 'Malibagh' AND node_b = 'Moghbazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Shahbagh', 'New Market', 1.528, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Shahbagh' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Shahbagh'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Karwan Bazar', 'Farmgate', 1.050, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Karwan Bazar' AND node_b = 'Farmgate') OR (node_a = 'Farmgate' AND node_b = 'Karwan Bazar'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Jatrabari', 'Sayedabad', 1.250, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Jatrabari' AND node_b = 'Sayedabad') OR (node_a = 'Sayedabad' AND node_b = 'Jatrabari'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Sayedabad', 'Kotwali', 2.148, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Sayedabad' AND node_b = 'Kotwali') OR (node_a = 'Kotwali' AND node_b = 'Sayedabad'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Bashundhara', 'Natun Bazar', 3.000, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Bashundhara' AND node_b = 'Natun Bazar') OR (node_a = 'Natun Bazar' AND node_b = 'Bashundhara'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Kuril', 'Bashundhara', 1.250, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Kuril' AND node_b = 'Bashundhara') OR (node_a = 'Bashundhara' AND node_b = 'Kuril'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Khilgaon', 'Motijheel', 1.021, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Khilgaon' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Khilgaon'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Paltan', 'Motijheel', 0.700, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Paltan' AND node_b = 'Motijheel') OR (node_a = 'Motijheel' AND node_b = 'Paltan'));

INSERT INTO roads_graph (node_a, node_b, distance_km, hazard_score, traffic_density, is_blocked)
SELECT 'Lalbagh', 'New Market', 2.129, 0.150, 0.350, FALSE FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM roads_graph WHERE (node_a = 'Lalbagh' AND node_b = 'New Market') OR (node_a = 'New Market' AND node_b = 'Lalbagh'));
